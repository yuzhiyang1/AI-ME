"""Skill 身份与目录规则；正文是任务资料，不能授予执行权限。"""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Skill:
    """一次发现的不可变元信息；version 是文件内容哈希。"""

    ref: str
    name: str
    description: str
    root: str
    path: str
    version: str
    explicit_only: bool = False
    enabled: bool = True
    pinned: bool = False
    shadowed: bool = False


class SkillError(ValueError):
    """可直接交给用户或模型处理的稳定错误。"""


def text_cost(value: str) -> int:
    """按 UTF-8 字节保守估算，与当前请求计数器保持同一上界。"""
    return len(value.encode("utf-8"))


def bounded_text(value: str, budget: int) -> str:
    """在完整 Unicode 字符边界裁剪，budget 单位为保守估算 token。"""
    return value.encode("utf-8")[: max(0, budget)].decode("utf-8", errors="ignore")
