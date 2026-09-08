"""工具审批应用语义异常。"""


class ToolInvocationNotFound(LookupError):
    """工具调用不存在。"""


class ApprovalNotFound(LookupError):
    """审批请求不存在。"""


class ApprovalAlreadyResolved(RuntimeError):
    """审批请求已经有最终决定。"""
