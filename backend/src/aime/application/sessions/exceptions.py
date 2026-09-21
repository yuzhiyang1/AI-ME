"""Session 应用层可公开处理的稳定异常。"""


class ActiveTurnConflict(RuntimeError):
    """Session 已有其他活跃 Turn。"""


class TurnNotActive(RuntimeError):
    """目标 Turn 不属于该 Session 或已经结束。"""


class IdempotencyConflict(RuntimeError):
    """同一幂等键被用于不同的业务输入。"""
