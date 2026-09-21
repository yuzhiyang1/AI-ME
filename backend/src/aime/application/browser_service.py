"""浏览器任务编排：真实会话、单运行、人工审批和可取消执行。"""

import asyncio
from dataclasses import dataclass
from uuid import UUID, uuid4

from aime.application.browser_configuration import BrowserConfigurationService
from aime.application.ports.browser import (
    BrowserBridge,
    BrowserPlanner,
    BrowserRunRepository,
    BrowserTextGenerator,
)
from aime.application.sessions.services import GetSession
from aime.domain.browser import (
    BrowserConflict,
    BrowserError,
    BrowserRun,
    BrowserRunNotFound,
    BrowserStatus,
    BrowserUnavailable,
    parse_snapshot,
)


@dataclass(slots=True)
class _Execution:
    """可取消资源归属一次运行，审批不能泄漏到后续运行。"""

    run: BrowserRun
    task: asyncio.Task[None] | None = None
    approval: asyncio.Future[bool] | None = None


class BrowserService:
    def __init__(
        self, sessions: GetSession, bridge: BrowserBridge,
        planner: BrowserPlanner, text: BrowserTextGenerator,
        configuration: BrowserConfigurationService, runs: BrowserRunRepository,
        *, max_active: int = 4, run_timeout: float = 600,
    ) -> None:
        self._sessions = sessions
        self._bridge = bridge
        self._planner = planner
        self._text = text
        self._configuration = configuration
        self._runs = runs
        self._configuration_lock = asyncio.Lock()
        self._max_active = max_active
        self._run_timeout = run_timeout
        self._executions: dict[str, _Execution] = {}
        self._closed = False

    async def initialize(self) -> None:
        await self._configuration.initialize()
        await self._runs.recover()

    def config(self) -> dict[str, object]:
        """仅暴露配置状态和模型名，不返回任何密钥。"""
        return {
            "configured": self._planner.configured,
            "model": self._planner.model,
            "textConfigured": self._text.configured,
            "bridgeConnected": self._bridge.connection_id is not None,
        }

    async def save_config(
        self, model: str, api_key: str | None, clear_api_key: bool,
    ) -> dict[str, object]:
        async with self._configuration_lock:
            if any(self._busy(e) for e in self._executions.values()):
                raise BrowserConflict("存在活动浏览器任务，停止后才能修改 Jev 配置")
            await self._configuration.save(model, api_key, clear_api_key)
            return self.config()

    @staticmethod
    def _busy(execution: _Execution) -> bool:
        return execution.run.active or (execution.task is not None and not execution.task.done())

    async def start(
        self, session_id: UUID, goal: str, max_steps: int = 20,
        text_model_ref: str | None = None, confirm_each_action: bool = True,
    ) -> BrowserRun:
        await self._sessions.execute(session_id)
        async with self._configuration_lock:
            return await self._start(
                session_id, goal, max_steps, text_model_ref, confirm_each_action,
            )

    async def _start(
        self, session_id: UUID, goal: str, max_steps: int,
        text_model_ref: str | None, confirm_each_action: bool,
    ) -> BrowserRun:
        identity = str(session_id)
        previous = self._executions.get(identity)
        if previous is not None and self._busy(previous):
            raise BrowserConflict("该会话已有活动浏览器任务")
        if sum(self._busy(e) for e in self._executions.values()) >= self._max_active:
            raise BrowserConflict("浏览器任务并发已达上限")
        if self._closed or not self._planner.configured:
            raise BrowserUnavailable("浏览器服务未就绪或未配置 TYPESAFE_API_KEY")
        connection_id = self._bridge.connection_id
        if connection_id is None:
            raise BrowserUnavailable("桌面浏览器未连接")
        if not goal.strip() or len(goal) > 8000 or not 1 <= max_steps <= 100:
            raise BrowserError("目标或最大步数无效")
        self._text.validate_model(text_model_ref)
        execution = _Execution(BrowserRun(str(uuid4()), identity, goal.strip()))
        # start 和配置保存共享锁，持久化期间并发 start 也不能穿透活动检查。
        await self._runs.save(execution.run)
        self._executions[identity] = execution
        execution.task = asyncio.create_task(self._run(
            execution, connection_id, max_steps, text_model_ref, confirm_each_action,
        ))
        return execution.run

    async def current(self, session_id: UUID) -> BrowserRun | None:
        await self._sessions.execute(session_id)
        execution = self._executions.get(str(session_id))
        return execution.run if execution else await self._runs.current(str(session_id))

    def _get(self, session_id: UUID, run_id: UUID) -> _Execution:
        execution = self._executions.get(str(session_id))
        if execution is None or execution.run.id != str(run_id):
            raise BrowserRunNotFound("该会话下不存在指定浏览器任务")
        return execution

    async def stop(self, session_id: UUID, run_id: UUID) -> BrowserRun:
        try:
            execution = self._get(session_id, run_id)
        except BrowserRunNotFound:
            saved = await self.current(session_id)
            if saved is not None and saved.id == str(run_id):
                return saved
            raise
        if execution.run.active:
            execution.run.status = BrowserStatus.STOPPED
            execution.run.pending_action = None
            if execution.task is not None:
                execution.task.cancel()
                await asyncio.gather(execution.task, return_exceptions=True)
            await self._runs.save(execution.run)
        elif execution.task is not None and not execution.task.done():
            # 终态可能已公开但最后一次落库尚未完成，关闭数据库前必须等待它结束。
            await asyncio.gather(execution.task, return_exceptions=True)
        return execution.run

    def approve(
        self, session_id: UUID, run_id: UUID, approve: bool, approval_id: str,
    ) -> BrowserRun:
        execution = self._get(session_id, run_id)
        if (
            execution.run.status != BrowserStatus.AWAITING_APPROVAL
            or execution.approval is None or execution.approval.done()
            or execution.run.pending_action is None
            or execution.run.pending_action.get("approvalId") != approval_id
        ):
            raise BrowserConflict("当前没有待确认动作或已经确认")
        # 同步消费审批身份，重放请求不能批准本步或未来另一步。
        execution.run.status = BrowserStatus.RUNNING if approve else BrowserStatus.STOPPED
        execution.run.pending_action = None
        execution.approval.set_result(approve)
        return execution.run

    async def close(self) -> None:
        """应用关闭先取消模型和审批，再由装配根释放 HTTP 客户端。"""
        self._closed = True
        for execution in list(self._executions.values()):
            await self.stop(UUID(execution.run.session_id), UUID(execution.run.id))

    async def _run(
        self, execution: _Execution, connection_id: str, max_steps: int,
        text_model_ref: str | None, confirm_each_action: bool,
    ) -> None:
        run = execution.run
        worker = asyncio.create_task(self._drive(
            execution, connection_id, max_steps, text_model_ref, confirm_each_action,
        ))
        disconnected = asyncio.create_task(self._bridge.wait_disconnected(connection_id))
        try:
            async with asyncio.timeout(self._run_timeout):
                done, _ = await asyncio.wait(
                    (worker, disconnected), return_when=asyncio.FIRST_COMPLETED,
                )
                if disconnected in done:
                    raise BrowserUnavailable("桌面浏览器已断开；已发送动作的结果需要人工核验")
                await worker
        except asyncio.CancelledError:
            run.status = BrowserStatus.STOPPED
            run.error = "任务已停止；已发送动作的结果需要人工核验"
            raise
        except TimeoutError:
            run.status, run.error = BrowserStatus.FAILED, "浏览器任务或模型调用超时"
        except BrowserError as exc:
            run.status, run.error = BrowserStatus.FAILED, str(exc)
        except Exception:
            run.status, run.error = BrowserStatus.FAILED, "浏览器任务执行失败"
        finally:
            # stop 返回前等待取消传播完成，保证不会继续发出新的动作。
            worker.cancel()
            disconnected.cancel()
            await asyncio.gather(worker, disconnected, return_exceptions=True)
            if execution.approval is not None:
                execution.approval.cancel()
            execution.approval = None
            run.pending_action = None
            try:
                await self._runs.save(run)
            except Exception:
                run.status, run.error = BrowserStatus.FAILED, "运行轨迹持久化失败，请人工核验页面"

    async def _drive(
        self, execution: _Execution, connection_id: str, max_steps: int,
        text_model_ref: str | None, confirm_each_action: bool,
    ) -> None:
        run = execution.run
        for _ in range(max_steps):
            observed = await self._bridge.request(
                run.session_id, "observe", {"runId": run.id}, connection_id=connection_id,
            )
            snapshot = parse_snapshot(observed)
            async with asyncio.timeout(60):
                decision = await self._planner.choose(snapshot, run.goal, run.steps)
            if not decision.confident():
                run.status, run.error = BrowserStatus.BLOCKED, "模型操作或目标置信度不足"
                return
            if decision.operation in ("DONE", "BLOCKED"):
                run.steps.append({"operation": decision.operation, "snapshotId": snapshot.id})
                run.status = (
                    BrowserStatus.NEEDS_VERIFICATION if decision.operation == "DONE"
                    else BrowserStatus.BLOCKED
                )
                return
            action = next((a for a in snapshot.actions if a.id == decision.action_id), None)
            if action is None:
                raise BrowserError("模型选择的动作不在当前观察中")
            expected_operation = {
                "click": "CLICK", "fill": "TYPE_TEXT", "select": "SELECT",
                "scroll": "SCROLL", "wait": "WAIT",
            }[action.kind]
            if decision.operation != expected_operation:
                raise BrowserError("模型操作与观察到的目标类型不一致")
            arguments: dict[str, object] = {
                "snapshotId": snapshot.id, "actionId": action.id, "runId": run.id,
            }
            if action.kind == "fill":
                async with asyncio.timeout(60):
                    arguments["text"] = await self._text.generate(
                        snapshot, action, run.goal, text_model_ref,
                    )
            pending: dict[str, object] = {
                **arguments, "kind": action.kind, "label": action.label,
                "url": snapshot.url, "confidence": decision.confidence,
                "targetConfidence": decision.target_confidence,
            }
            step = {**pending, "operation": decision.operation, "status": "planned"}
            run.steps.append(step)
            if confirm_each_action and action.kind in ("click", "fill", "select"):
                pending["approvalId"] = str(uuid4())
                step["approvalId"] = pending["approvalId"]
                step["status"] = "awaiting_approval"
                execution.approval = asyncio.get_running_loop().create_future()
                run.pending_action = pending
                run.status = BrowserStatus.AWAITING_APPROVAL
                await self._runs.save(run)
                approved = await execution.approval
                execution.approval = None
                run.pending_action = None
                if not approved:
                    step["status"] = "rejected"
                    run.status = BrowserStatus.STOPPED
                    return
                run.status = BrowserStatus.RUNNING
                step["approved"] = True
            # 先落执行意图，进程崩溃后不会把已发但未确认的动作误称为完成。
            step["status"] = "dispatching"
            await self._runs.save(run)
            # 审批后仍只提交原快照身份；Electron 拒绝过期快照，不能静默重选目标。
            result = await self._bridge.request(
                run.session_id, "act", arguments, connection_id=connection_id,
            )
            if result.get("outcome") == "uncertain":
                step["status"] = "uncertain"
                run.status = BrowserStatus.NEEDS_VERIFICATION
                run.error = "网页动作结果不确定，请人工核验后再启动新任务"
                await self._runs.save(run)
                return
            if result.get("ok") is not True:
                raise BrowserError("桌面未确认动作执行成功，请人工核验")
            step["status"] = "executed"
            await self._runs.save(run)
        run.status, run.error = BrowserStatus.BLOCKED, "达到最大步数，请检查页面后再继续"
