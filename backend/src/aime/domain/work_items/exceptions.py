"""工作事项领域异常。"""


class DomainRuleViolation(ValueError):
    """领域规则被违反。"""


class InvalidWorkItemTransition(DomainRuleViolation):
    """工作事项发生非法状态转换。"""

