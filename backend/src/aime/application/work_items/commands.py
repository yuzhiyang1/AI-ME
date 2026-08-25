"""工作事项用例输入。"""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class CreateWorkItemCommand:
    """创建工作事项的输入命令。"""

    title: str

