"""受限目录发现及资源读取；不跟随符号链接，不执行 Skill 脚本。"""

import asyncio
import hashlib
import os
from pathlib import Path

import yaml

from aime.domain.skills import Skill, SkillError

MAX_FILE_BYTES = 256_000
MAX_SCAN_ENTRIES = 20_000


class LocalSkillResources:
    """根来源明确、扫描有界的本地适配器。"""

    def __init__(self, personal_roots: tuple[Path, ...]) -> None:
        self._personal = personal_roots

    async def discover(self, roots: tuple[str, ...]) -> tuple[list[Skill], list[str]]:
        return await asyncio.to_thread(self._discover, roots)

    def _discover(self, roots: tuple[str, ...]) -> tuple[list[Skill], list[str]]:
        sources = [Path(root) / ".agents" / "skills" for root in roots] + list(self._personal)
        skills: list[Skill] = []
        errors: list[str] = []
        seen: set[str] = set()
        scanned = 0
        for source in dict.fromkeys(sources):
            if not source.exists():
                continue
            try:
                root = source.absolute()
                # 根本身及中间父级也不能通过链接逃逸。
                if root.resolve() != root or not root.is_dir():
                    raise SkillError("Skill 根包含链接或不是目录")
                root_id = hashlib.sha256(os.path.normcase(str(root)).encode()).hexdigest()[:20]
                pending = [root]
                while pending:
                    directory = pending.pop()
                    scanned += 1
                    if scanned > MAX_SCAN_ENTRIES:
                        errors.append("skill_scan_limit: 扫描超过 20000 个条目，发现不完整")
                        return skills, errors
                    file = directory / "SKILL.md"
                    if file.exists():
                        try:
                            raw = self._read_file(root, file)
                            if not raw.startswith("---\n"):
                                raise SkillError("SKILL.md 必须包含 YAML 头")
                            parts = raw.split("\n---", 1)
                            if len(parts) != 2:
                                raise SkillError("YAML 头未闭合")
                            data = yaml.safe_load(parts[0][4:])
                            if not isinstance(data, dict):
                                raise SkillError("Skill 元信息必须是映射")
                            name, description = data.get("name"), data.get("description")
                            if not isinstance(name, str) or not name.strip() or len(name) > 64:
                                raise SkillError("name 必须是 1 至 64 字符")
                            if not isinstance(description, str) or not description.strip():
                                raise SkillError("description 不能为空")
                            name = name.strip()
                            ref = f"{root_id}:{directory.relative_to(root).as_posix()}"
                            if len(ref) > 1024:
                                raise SkillError("Skill 引用过长")
                            skills.append(
                                Skill(
                                    ref,
                                    name,
                                    description.strip()[:1024],
                                    str(root),
                                    str(directory),
                                    hashlib.sha256(raw.encode()).hexdigest(),
                                    data.get("disable-model-invocation") is True,
                                    shadowed=name.casefold() in seen,
                                )
                            )
                            seen.add(name.casefold())
                        except (OSError, ValueError, yaml.YAMLError) as exc:
                            errors.append(f"{file}: {exc}"[:1000])
                        continue
                    for child in sorted(directory.iterdir(), reverse=True):
                        scanned += 1
                        if scanned > MAX_SCAN_ENTRIES:
                            errors.append("skill_scan_limit: 扫描条目超过上限")
                            return skills, errors
                        if child.is_symlink() or child.resolve() != child.absolute():
                            errors.append(f"blocked_path: {child}"[:1000])
                        elif child.is_dir() and not child.name.startswith("."):
                            pending.append(child)
            except (OSError, ValueError) as exc:
                errors.append(f"{source}: {exc}"[:1000])
        return skills, errors[:100]

    async def read(self, skill: Skill, resource: str) -> str:
        """主文件在首次读取时核对快照版本，附件同样必须留在 Skill 根内。"""

        def read() -> str:
            root = Path(skill.path)
            main = self._read_file(Path(skill.root), root / "SKILL.md")
            if hashlib.sha256(main.encode()).hexdigest() != skill.version:
                raise SkillError("skill_version_changed: 文件已改变，请在新一轮重新加载")
            target = Path(resource)
            if target.is_absolute() or ".." in target.parts or ":" in resource:
                raise SkillError("blocked_path: 附件必须是 Skill 内的相对路径")
            return self._read_file(root, root / target)

        return await asyncio.to_thread(read)

    @staticmethod
    def _read_file(root: Path, file: Path) -> str:
        resolved = file.resolve(strict=True)
        if not resolved.is_relative_to(root.resolve()) or resolved != file.absolute():
            raise SkillError("blocked_path: 不允许链接或目录逃逸")
        with resolved.open("rb") as stream:
            raw = stream.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            raise SkillError("skill_file_too_large: 单文件超过 256000 字节")
        return raw.decode("utf-8").replace("\r\n", "\n")
