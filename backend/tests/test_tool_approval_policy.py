"""验证工具参数触发的动态审批策略。"""

from aime.infrastructure.runtime.model_agent_runtime import _approval_reason


def test_edit_deletion_requires_approval() -> None:
    """删除已有文本属于破坏性编辑，必须先征得用户同意。"""
    reason = _approval_reason(
        "edit_file",
        {"path": "notes.txt", "old_text": "obsolete", "new_text": ""},
    )

    assert reason == "即将从文件中删除匹配内容：notes.txt"


def test_edit_replace_all_requires_approval() -> None:
    """批量替换影响范围较大，即使保留文本也必须先审批。"""
    reason = _approval_reason(
        "edit_file",
        {
            "path": "notes.txt",
            "old_text": "old",
            "new_text": "new",
            "replace_all": True,
        },
    )

    assert reason == "即将在文件中批量替换全部匹配内容：notes.txt"
