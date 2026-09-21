"""不可变本地产物；采集与模型预览分别限量。"""

import asyncio
import codecs
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import UUID, uuid4

from aime.domain.context.budget import ContextError

MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_SESSION_BYTES = 128 * 1024 * 1024
PREVIEW_BYTES = 2000


class LocalArtifactStore:
    """产物正文与元数据一起放在专用目录，不接受模型提供的文件路径。

    每次预留最大采集量，防止并行工具突破会话磁盘预算；发布前 fsync，
    临时文件不参与读取。引用绑定会话，因此不能借 artifact_id 越权。
    """

    def __init__(self, root: Path) -> None:
        # 先建立根目录再规范化；Windows 对尚不存在的长路径解析可能不同。
        root.mkdir(parents=True, exist_ok=True)
        self._root = root.resolve(strict=True)
        self._lock = asyncio.Lock()
        self._reserved: dict[str, int] = {}

    def _directory(self, session_id: str) -> Path:
        directory = self._root / str(UUID(session_id))
        if directory.resolve().parent != self._root:
            raise ContextError("artifact_path_invalid", "产物目录不能指向存储根之外")
        return directory

    async def save(
        self,
        session_id: str,
        content: str,
        *,
        capture_complete: bool = True,
    ) -> dict[str, object]:
        """将文本分块送入采集流程；来源已截断时不能将已保存部分标成全文。"""

        async def chunks() -> AsyncIterator[bytes]:
            for start in range(0, len(content), 16_384):
                yield content[start : start + 16_384].encode("utf-8")

        return await self.capture(session_id, chunks(), capture_complete=capture_complete)

    async def capture(
        self,
        session_id: str,
        chunks: AsyncIterator[bytes],
        *,
        capture_complete: bool = True,
    ) -> dict[str, object]:
        """预留采集配额，流式保存正文，再发布元数据、首尾预览和会话内引用。

        超过采集上限仍消费剩余输入，但标记正文不完整；读者需区分预览截断
        与正文缺失。成功或失败均释放内存预留额度，已发布文件仍占磁盘配额。
        """
        # 预留在当前 Store 实例的锁内完成，避免本进程并行采集各自看见相同余额。
        directory = self._directory(session_id)
        async with self._lock:
            await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)
            used = await asyncio.to_thread(
                lambda: sum(path.stat().st_size for path in directory.iterdir() if path.is_file())
            )
            reserved = self._reserved.get(session_id, 0)
            if used + reserved + MAX_ARTIFACT_BYTES > MAX_SESSION_BYTES:
                raise ContextError("artifact_quota_exceeded", "会话产物存储已达上限")
            self._reserved[session_id] = reserved + MAX_ARTIFACT_BYTES

        artifact_id = str(uuid4())
        temporary = directory / f"{artifact_id}.partial"
        destination = directory / f"{artifact_id}.txt"
        total = 0
        saved = 0
        head = b""
        tail = b""
        try:
            # 单次写入最多一个采集块；即使超过上限也继续排空管道，避免子进程阻塞。
            with temporary.open("xb") as handle:
                async for chunk in chunks:
                    total += len(chunk)
                    kept = chunk[: max(0, MAX_ARTIFACT_BYTES - saved)]
                    if kept:
                        await asyncio.to_thread(handle.write, kept)
                        saved += len(kept)
                    head = (head + chunk)[:PREVIEW_BYTES]
                    tail = (tail + chunk)[-PREVIEW_BYTES:]
                await asyncio.to_thread(handle.flush)
                await asyncio.to_thread(os.fsync, handle.fileno())
            await asyncio.to_thread(os.replace, temporary, destination)
            # total 是来源字节数，saved 是落盘字节数；尾部预览可能来自未保存部分。
            complete = capture_complete and total == saved
            metadata: dict[str, object] = {
                "artifact_id": artifact_id,
                "total_bytes": total,
                "saved_bytes": saved,
                "capture_complete": complete,
                "capture_reason": None if complete else "capture_limit_or_source_truncated",
            }
            metadata_path = directory / f"{artifact_id}.json"
            # 元数据不可见期间没有引用对外发布；调用者必须在 save 返回后才落 T2。
            with metadata_path.open("x", encoding="utf-8") as handle:
                json.dump(metadata, handle)
                handle.flush()
                os.fsync(handle.fileno())
            preview = head.decode("utf-8", errors="replace")
            if total > PREVIEW_BYTES:
                preview += "\n…（预览已截断，请使用 artifact_read）…\n" + tail.decode(
                    "utf-8", errors="replace"
                )
            return {**metadata, "preview": preview, "truncated": total > PREVIEW_BYTES}
        finally:
            async with self._lock:
                self._reserved[session_id] -= MAX_ARTIFACT_BYTES
            if temporary.exists():
                await asyncio.to_thread(temporary.unlink)

    def _paths(self, session_id: str, artifact_id: str) -> tuple[Path, Path]:
        """只解析当前会话内的 UUID 产物，正文和元数据齐备后才允许读取。"""
        directory = self._directory(session_id)
        name = str(UUID(artifact_id))
        paths = directory / f"{name}.txt", directory / f"{name}.json"
        if any(path.is_symlink() or path.resolve().parent != directory.resolve() for path in paths):
            raise ContextError("artifact_path_invalid", "产物路径不能是符号链接")
        if not all(path.is_file() for path in paths):
            raise ContextError("artifact_not_found", "产物不存在或不属于当前会话")
        return paths

    async def read(
        self,
        session_id: str,
        artifact_id: str,
        offset: int = 0,
        limit: int = 4000,
    ) -> dict[str, object]:
        """按 UTF-8 字节偏移读取有界正文；连续翻页应使用返回的 next_offset。

        页长至少留出一个 UTF-8 字符的空间，避免多字节字符令游标停滞。
        """
        path, metadata_path = self._paths(session_id, artifact_id)
        offset, limit = max(0, offset), max(4, min(limit, 4000))

        def read_slice() -> dict[str, object]:
            with path.open("rb") as handle:
                handle.seek(offset)
                content = handle.read(limit)
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            # 翻页不切断 UTF-8 字符；next_offset 指向未解码的尾部起点。
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            decoded = decoder.decode(content, final=offset + len(content) >= path.stat().st_size)
            pending, _ = decoder.getstate()
            end = offset + len(content) - len(pending)
            return {
                **metadata,
                "content": decoded,
                "offset_bytes": offset,
                "next_offset": end if end < path.stat().st_size else None,
            }

        return await asyncio.to_thread(read_slice)

    async def search(
        self,
        session_id: str,
        artifact_id: str,
        query: str,
        offset: int = 0,
    ) -> dict[str, object]:
        """在有界字节区间中搜索最多五处匹配；未命中也可能需要按游标继续扫描。"""
        if not query or len(query.encode("utf-8")) > 1000:
            raise ContextError("artifact_query_invalid", "关键词必须为 1 到 1000 字节")
        path, _ = self._paths(session_id, artifact_id)

        def search_chunk() -> dict[str, object]:
            # 每次最多扫描 64 KiB，跨块重叠保证关键词不会在分页边界漏掉。
            needle = query.encode("utf-8")
            start = max(0, offset)
            with path.open("rb") as handle:
                handle.seek(start)
                data = handle.read(65_536 + len(needle))
            matches: list[dict[str, object]] = []
            position = data.find(needle)
            while 0 <= position < 65_536 and len(matches) < 5:
                matches.append(
                    {
                        "offset_bytes": start + position,
                        "preview": data[
                            max(0, position - 100) : position + len(needle) + 100
                        ].decode("utf-8", errors="replace"),
                    }
                )
                position = data.find(needle, position + len(needle))
            next_offset = start + (position if len(matches) == 5 and position >= 0 else 65_536)
            return {
                "matches": matches,
                "next_offset": next_offset if next_offset < path.stat().st_size else None,
            }

        return await asyncio.to_thread(search_chunk)
