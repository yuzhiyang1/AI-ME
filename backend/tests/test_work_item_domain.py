"""工作事项领域行为测试。"""

import pytest

from aime.domain.work_items import WorkItem, WorkItemStatus, WorkItemTitle
from aime.domain.work_items.exceptions import InvalidWorkItemTransition


def test_work_item_follows_expected_lifecycle() -> None:
    item = WorkItem.create(WorkItemTitle("整理线上故障证据"))

    assert item.status is WorkItemStatus.PENDING

    item.start()
    assert item.status is WorkItemStatus.IN_PROGRESS

    item.complete()
    assert item.status is WorkItemStatus.COMPLETED


def test_work_item_rejects_completion_before_start() -> None:
    item = WorkItem.create(WorkItemTitle("生成数据查询结果"))

    with pytest.raises(InvalidWorkItemTransition):
        item.complete()

