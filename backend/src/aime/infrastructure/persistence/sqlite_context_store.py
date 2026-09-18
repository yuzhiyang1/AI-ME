"""SQLite 上下文事务；提交后调用者才可以替换内存窗口。"""

import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from aime.application.context.messages import (
    decode_message,
    dump_messages,
    encode_message,
    load_messages,
)
from aime.application.ports.context_store import (
    Checkpoint,
    ContextProgress,
    ContextWindow,
    PendingContextStep,
)
from aime.application.ports.model_gateway import (
    ConversationMessage,
    LlmAssistantToolCallMessage,
    LlmInputMessage,
    MessageRole,
)
from aime.domain.context.budget import ContextError


class SqliteContextStore:
    """历史投影用稳定 source_key 去重，Run 状态与完整步骤一同提交。"""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def save_pending_step(self, run_id: str, pending: PendingContextStep) -> None:
        """在工具 T1 前保存完整批次，避免崩溃后只知道已开始的那部分调用。"""
        async with self._sessions() as db, db.begin():
            await db.execute(
                text(
                    "UPDATE context_runs SET pending_json=:body "
                    "WHERE run_id=:run AND completed_step<:step"
                ),
                {
                    "run": run_id,
                    "step": pending.step,
                    "body": json.dumps(
                        {
                            "step": pending.step,
                            "message": encode_message(pending.message),
                            "allowed_tools": pending.allowed_tools,
                        },
                        ensure_ascii=False,
                    ),
                },
            )

    async def pending_step(self, run_id: str) -> PendingContextStep | None:
        """恢复尚未提交的工具批次及当时的工具白名单；无待恢复批次时返回空。"""
        async with self._sessions() as db:
            body = (
                await db.execute(
                    text("SELECT pending_json FROM context_runs WHERE run_id=:run"), {"run": run_id}
                )
            ).scalar_one_or_none()
            if body is None:
                return None
            data = json.loads(body)
            message = decode_message(data["message"])
            if not isinstance(message, LlmAssistantToolCallMessage):
                raise ContextError("context_pending_invalid", "未完成步骤不是有效工具批次")
            return PendingContextStep(data["step"], message, tuple(data["allowed_tools"]))

    async def initialize(
        self,
        session_id: str,
        turn_id: str,
        run_id: str,
        messages: tuple[LlmInputMessage, ...],
        instruction: str,
    ) -> ContextWindow:
        """事务接入会话：首次导入旧消息，按 Turn 去重当前请求，再初始化 Run 预算。

        重启时复用活动窗口及已有请求计数，不重新导入整个会话。
        """
        async with self._sessions() as db, db.begin():
            # 先取得 SQLite 写锁，再判断是否创建首个窗口，避免并发初始化竞争。
            await db.execute(
                text("UPDATE agent_sessions SET id=id WHERE id=:sid"), {"sid": session_id}
            )
            row = await _active(db, session_id)
            if row is None:
                window_id = str(uuid4())
                await db.execute(
                    text("INSERT INTO context_windows VALUES (:id,:sid,1,0,'[]',1,:key,'initial')"),
                    {"id": window_id, "sid": session_id, "key": f"initial:{session_id}"},
                )
                # 首次启用时导入原会话消息；以后只追加当前用户请求，避免整段重复。
                for index, message in enumerate(messages[:-1]):
                    await _append(db, session_id, window_id, f"legacy:{index}", message)
            else:
                window_id = str(row["id"])
            await _append(
                db,
                session_id,
                window_id,
                f"user:{turn_id}",
                ConversationMessage(MessageRole.USER, instruction),
            )
            await db.execute(
                text(
                    "INSERT OR IGNORE INTO context_runs "
                    "(run_id,completed_step,request_count,failure_count) VALUES (:run,0,0,0)"
                ),
                {"run": run_id},
            )
        return await self.window(session_id)

    async def window(self, session_id: str) -> ContextWindow:
        """返回会话活动窗口快照；未初始化时明确失败。"""
        async with self._sessions() as db:
            row = await _active(db, session_id)
            if row is None:
                raise ContextError("context_missing", "找不到活动上下文窗口")
            return _window(row)

    async def messages(self, session_id: str) -> list[LlmInputMessage]:
        """以窗口基线加覆盖边界之后的历史重建消息，避免把旧窗口正文再次塞回。"""
        async with self._sessions() as db:
            row = await _active(db, session_id)
            if row is None:
                raise ContextError("context_missing", "找不到活动上下文窗口")
            items = (
                (
                    await db.execute(
                        text(
                            "SELECT message_json FROM history_items "
                            "WHERE session_id=:sid AND id>:seq ORDER BY id"
                        ),
                        {"sid": session_id, "seq": row["through_sequence"]},
                    )
                )
                .scalars()
                .all()
            )
            return load_messages(row["baseline_json"]) + [
                decode_message(json.loads(item)) for item in items
            ]

    async def progress(self, run_id: str) -> ContextProgress:
        """读取 Run 的持久计数与终态，并从已提交步骤重建可恢复的回答正文。"""
        async with self._sessions() as db:
            row = (
                (
                    await db.execute(
                        text("SELECT * FROM context_runs WHERE run_id=:run"), {"run": run_id}
                    )
                )
                .mappings()
                .one()
            )
            # 只恢复已提交完整步骤的正文；失败流式草稿保留在事件日志但不接入回答。
            bodies = (
                (
                    await db.execute(
                        text(
                            "SELECT message_json FROM history_items "
                            "WHERE source_key LIKE :prefix ORDER BY id"
                        ),
                        {"prefix": f"{run_id}:%"},
                    )
                )
                .scalars()
                .all()
            )
            decoded = [json.loads(body) for body in bodies]
            response = "".join(
                item.get("content", "")
                for item in decoded
                if item["kind"] == "call" or item.get("role") == "assistant"
            )
            return ContextProgress(
                row["completed_step"],
                row["request_count"],
                row["overflow_step"],
                row["failure_signature"],
                row["failure_count"],
                response,
                bool(row["finished"]),
            )

    async def begin_request(self, run_id: str, maximum: int) -> int:
        """原子消耗一次模型请求额度并返回累计次数；发送失败也不返还额度。"""
        async with self._sessions() as db, db.begin():
            value = (
                await db.execute(
                    text(
                        "UPDATE context_runs SET request_count=request_count+1 "
                        "WHERE run_id=:run AND request_count<:maximum RETURNING request_count"
                    ),
                    {"run": run_id, "maximum": maximum},
                )
            ).scalar_one_or_none()
            if value is None:
                raise ContextError("run_budget_exhausted", f"模型请求已达到上限 {maximum}")
            return int(value)

    async def record_step(
        self,
        session_id: str,
        run_id: str,
        step: int,
        messages: list[LlmInputMessage],
        failure_signature: str | None,
        failure_count: int,
        *,
        final: bool = False,
    ) -> None:
        """事务追加完整步骤历史、推进 Run 游标并清除待恢复批次。

        历史按 Run、步骤和消息位置去重；失败计数由调用方计算后随步骤提交。
        不能先推进游标再单独写历史，否则重启可能跳过未保存的工具结果。
        """
        async with self._sessions() as db, db.begin():
            await db.execute(
                text("UPDATE context_runs SET run_id=run_id WHERE run_id=:run"), {"run": run_id}
            )
            row = await _active(db, session_id)
            assert row is not None
            for index, message in enumerate(messages):
                await _append(db, session_id, row["id"], f"{run_id}:{step}:{index}", message)
            await db.execute(
                text(
                    "UPDATE context_runs SET completed_step=:step, failure_signature=:sig, "
                    "failure_count=:count, finished=:final, pending_json=NULL "
                    "WHERE run_id=:run AND completed_step<:step"
                ),
                {
                    "step": step,
                    "sig": failure_signature,
                    "count": failure_count,
                    "run": run_id,
                    "final": final,
                },
            )

    async def checkpoint(self, session_id: str) -> Checkpoint:
        """读取会话最新笔记；尚未写入时返回版本为零的空 Checkpoint。"""
        async with self._sessions() as db:
            return await _checkpoint(db, session_id)

    async def write_checkpoint(
        self,
        session_id: str,
        run_id: str,
        operation_id: str,
        expected_version: int,
        covered_sequence: int,
        content: dict[str, object],
    ) -> Checkpoint:
        """校验笔记结构后，在事务中处理幂等重试、版本冲突与历史引用，再追加版本。

        覆盖范围不得倒退，引用必须属于本会话且位于覆盖范围内。
        校验的是结构和引用边界，不验证模型所写进展是否符合真实执行结果。
        """
        # 先挡住不可存储的内容；进入事务后再检查依赖最新持久状态的约束。
        encoded = json.dumps(content, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 12_000:
            raise ContextError("checkpoint_too_large", "Checkpoint 不能超过 12000 UTF-8 字节")
        fields = ("goal", "progress", "constraints", "decisions", "failed_attempts", "next_steps")
        if any(not isinstance(content.get(key), str) for key in fields):
            raise ContextError("checkpoint_invalid", "六个任务字段必须全部提供字符串")
        references = content.get("references", [])
        if not isinstance(references, list) or any(type(ref) is not int for ref in references):
            raise ContextError("checkpoint_invalid", "references 必须为 history item 整数 ID 列表")

        async with self._sessions() as db, db.begin():
            await db.execute(
                text("UPDATE context_runs SET run_id=run_id WHERE run_id=:run"), {"run": run_id}
            )
            # 同一工具调用重试应拿回原版本，不能先用旧 expected_version 判为冲突。
            prior = (
                (
                    await db.execute(
                        text(
                            "SELECT version,covered_sequence,content_json FROM context_checkpoints "
                            "WHERE session_id=:sid AND operation_id=:op"
                        ),
                        {"sid": session_id, "op": f"{run_id}:{operation_id}"},
                    )
                )
                .mappings()
                .first()
            )
            if prior:
                return Checkpoint(
                    prior["version"], prior["covered_sequence"], json.loads(prior["content_json"])
                )
            # 新操作才校验版本和覆盖范围，防止过期笔记覆盖更新的任务状态。
            current = await _checkpoint(db, session_id)
            latest = await _latest(db, session_id)
            if current.version != expected_version:
                raise ContextError("checkpoint_conflict", f"当前版本为 {current.version}")
            if not current.covered_sequence <= covered_sequence <= latest:
                raise ContextError("checkpoint_invalid", "覆盖边界不能倒退或超过已保存历史")
            for ref in references:
                exists = (
                    await db.execute(
                        text(
                            "SELECT id FROM history_items WHERE session_id=:sid "
                            "AND id=:id AND id<=:seq"
                        ),
                        {"sid": session_id, "id": ref, "seq": covered_sequence},
                    )
                ).scalar_one_or_none()
                if exists is None:
                    raise ContextError("checkpoint_reference_invalid", "引用不存在或超出覆盖范围")
            # 保留旧版本供追溯；新版本绑定写入时的活动窗口。
            active = await _active(db, session_id)
            assert active is not None
            await db.execute(
                text(
                    "INSERT INTO context_checkpoints "
                    "VALUES (:id,:sid,:window,:version,:seq,:body,:op)"
                ),
                {
                    "id": str(uuid4()),
                    "sid": session_id,
                    "window": active["id"],
                    "version": current.version + 1,
                    "seq": covered_sequence,
                    "body": encoded,
                    "op": f"{run_id}:{operation_id}",
                },
            )
        return Checkpoint(current.version + 1, covered_sequence, content)

    async def latest_sequence(self, session_id: str) -> int:
        """返回本会话最新历史 ID；空历史返回零，ID 不代表条目数量。"""
        async with self._sessions() as db:
            return await _latest(db, session_id)

    async def rollover(
        self,
        session_id: str,
        run_id: str,
        rollover_id: str,
        expected_window: str,
        through_sequence: int,
        baseline: list[LlmInputMessage],
        reason: str,
    ) -> ContextWindow:
        """事务校验换窗快照和当前 Run 工具终态，再切换活动指针并记录换窗事件。

        相同 rollover_id 返回原窗口；快照过期或工具未收敛则不切换。
        历史、Checkpoint 和 Run 请求预算均保留，换窗只改变模型输入基线。
        """
        async with self._sessions() as db, db.begin():
            # 先取得 SQLite 写锁，再检查窗口和历史边界；事务内不会漏掉并发追加。
            await db.execute(
                text("UPDATE agent_sessions SET id=id WHERE id=:sid"), {"sid": session_id}
            )
            duplicate = (
                (
                    await db.execute(
                        text(
                            "SELECT * FROM context_windows "
                            "WHERE session_id=:sid AND rollover_id=:key"
                        ),
                        {"sid": session_id, "key": rollover_id},
                    )
                )
                .mappings()
                .first()
            )
            if duplicate:
                return _window(dict(duplicate))
            old = await _active(db, session_id)
            if (
                old is None
                or old["id"] != expected_window
                or await _latest(db, session_id) != through_sequence
            ):
                raise ContextError("context_conflict", "窗口或历史边界已变化")
            unsettled = (
                await db.execute(
                    text(
                        "SELECT COUNT(*) FROM tool_invocations "
                        "WHERE session_id=:sid AND run_id=:run "
                        "AND status NOT IN ('completed','failed','rejected')"
                    ),
                    {"sid": session_id, "run": run_id},
                )
            ).scalar_one()
            if unsettled:
                raise ContextError("context_tools_unsettled", "工具尚未收敛，不能换窗")
            await db.execute(
                text("UPDATE context_windows SET active=0 WHERE id=:id"), {"id": expected_window}
            )
            window_id = str(uuid4())
            await db.execute(
                text(
                    "INSERT INTO context_windows "
                    "VALUES (:id,:sid,:number,:seq,:body,1,:key,:reason)"
                ),
                {
                    "id": window_id,
                    "sid": session_id,
                    "number": old["number"] + 1,
                    "seq": through_sequence,
                    "body": dump_messages(baseline),
                    "key": rollover_id,
                    "reason": reason,
                },
            )
            # 换窗事件与指针在同一事务提交，SSE 断开也可从事件历史恢复。
            sequence = (
                await db.execute(
                    text(
                        "UPDATE agent_sessions SET last_event_sequence=last_event_sequence+1 "
                        "WHERE id=:sid RETURNING last_event_sequence"
                    ),
                    {"sid": session_id},
                )
            ).scalar_one()
            await db.execute(
                text(
                    "INSERT INTO runtime_events "
                    "(id,session_id,turn_id,run_id,sequence,type,payload_json,created_at) "
                    "SELECT :id,:sid,turn_id,:run,:seq,'context_window_started',:body,:now "
                    "FROM agent_runs WHERE id=:run"
                ),
                {
                    "id": str(uuid4()),
                    "sid": session_id,
                    "run": run_id,
                    "seq": sequence,
                    "body": json.dumps(
                        {"windowId": window_id, "windowNumber": old["number"] + 1, "reason": reason}
                    ),
                    "now": datetime.now(UTC).isoformat(),
                },
            )
        return ContextWindow(window_id, old["number"] + 1, through_sequence, tuple(baseline))

    async def claim_overflow(self, run_id: str, step: int) -> bool:
        """持久领取当前逻辑步骤的溢出重试机会；该步骤重复领取返回 False。"""
        async with self._sessions() as db, db.begin():
            value = (
                await db.execute(
                    text(
                        "UPDATE context_runs SET overflow_step=:step "
                        "WHERE run_id=:run AND (overflow_step IS NULL OR overflow_step<>:step) "
                        "RETURNING run_id"
                    ),
                    {"run": run_id, "step": step},
                )
            ).scalar_one_or_none()
            return value is not None

    async def history(
        self,
        session_id: str,
        *,
        after: int = 0,
        query: str = "",
        window_id: str = "",
        role: str = "",
        tool: str = "",
    ) -> dict[str, object]:
        """按会话和过滤条件返回最多十条历史预览，以历史 ID 而非页码续查。"""
        async with self._sessions() as db:
            rows = (
                (
                    await db.execute(
                        text(
                            "SELECT id,window_id,role,tool,substr(message_json,1,300) AS preview "
                            "FROM history_items WHERE session_id=:sid AND id>:after "
                            "AND (:query='' OR instr(message_json,:query)>0) "
                            "AND (:window='' OR window_id=:window) AND (:role='' OR role=:role) "
                            "AND (:tool='' OR tool=:tool) ORDER BY id LIMIT 11"
                        ),
                        {
                            "sid": session_id,
                            "after": max(0, after),
                            "query": query,
                            "window": window_id,
                            "role": role,
                            "tool": tool,
                        },
                    )
                )
                .mappings()
                .all()
            )
            return {
                "items": [dict(row) for row in rows[:10]],
                "next_after": rows[9]["id"] if len(rows) > 10 else None,
            }

    async def claim_maintenance(self, run_id: str, window_id: str) -> bool:
        """为 Run 的当前窗口领取一次维护机会，重启后重复领取返回 False。"""
        async with self._sessions() as db, db.begin():
            value = (
                await db.execute(
                    text(
                        "UPDATE context_runs SET maintenance_window=:window "
                        "WHERE run_id=:run "
                        "AND (maintenance_window IS NULL OR maintenance_window<>:window) "
                        "RETURNING run_id"
                    ),
                    {"run": run_id, "window": window_id},
                )
            ).scalar_one_or_none()
            return value is not None

    async def read_history(
        self,
        session_id: str,
        item_id: int,
        offset: int = 0,
        limit: int = 4000,
    ) -> dict[str, object]:
        """分页读取本会话历史的序列化消息；偏移按字符计，与产物字节偏移不同。"""
        offset, limit = max(0, offset), max(1, min(limit, 4000))
        async with self._sessions() as db:
            row = (
                (
                    await db.execute(
                        text(
                            "SELECT substr(message_json,:start,:limit) AS content, "
                            "length(message_json) AS total FROM history_items "
                            "WHERE session_id=:sid AND id=:id"
                        ),
                        {"start": offset + 1, "limit": limit, "sid": session_id, "id": item_id},
                    )
                )
                .mappings()
                .first()
            )
            if row is None:
                raise ContextError("history_not_found", "历史条目不存在或不属于当前会话")
            end = offset + len(row["content"])
            return {
                "item_id": item_id,
                "content": row["content"],
                "total_chars": row["total"],
                "next_offset": end if end < row["total"] else None,
            }


async def _active(db: AsyncSession, session_id: str) -> dict[str, Any] | None:
    row = (
        (
            await db.execute(
                text("SELECT * FROM context_windows WHERE session_id=:sid AND active=1"),
                {"sid": session_id},
            )
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


def _window(row: dict[str, Any]) -> ContextWindow:
    return ContextWindow(
        row["id"],
        row["number"],
        row["through_sequence"],
        tuple(load_messages(row["baseline_json"])),
    )


async def _latest(db: AsyncSession, session_id: str) -> int:
    return int(
        (
            await db.execute(
                text("SELECT coalesce(max(id),0) FROM history_items WHERE session_id=:sid"),
                {"sid": session_id},
            )
        ).scalar_one()
    )


async def _checkpoint(db: AsyncSession, session_id: str) -> Checkpoint:
    row = (
        (
            await db.execute(
                text(
                    "SELECT * FROM context_checkpoints WHERE session_id=:sid "
                    "ORDER BY version DESC LIMIT 1"
                ),
                {"sid": session_id},
            )
        )
        .mappings()
        .first()
    )
    return (
        Checkpoint(row["version"], row["covered_sequence"], json.loads(row["content_json"]))
        if row
        else Checkpoint()
    )


async def _append(
    db: AsyncSession,
    session_id: str,
    window_id: str,
    key: str,
    message: LlmInputMessage,
) -> None:
    """在调用方事务内追加历史；稳定 source_key 使相同消息重放不产生重复事实。"""
    data = encode_message(message)
    await db.execute(
        text(
            "INSERT OR IGNORE INTO history_items "
            "(session_id,window_id,source_key,role,tool,message_json) "
            "VALUES (:sid,:window,:key,:role,:tool,:body)"
        ),
        {
            "sid": session_id,
            "window": window_id,
            "key": key,
            "role": data.get("role", "tool" if data["kind"] == "result" else "assistant"),
            "tool": data.get("name", ""),
            "body": json.dumps(data, ensure_ascii=False),
        },
    )
