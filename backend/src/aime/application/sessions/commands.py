"""Agent Session 用例输入。"""

from dataclasses import dataclass
from uuid import UUID

from aime.domain.sessions.value_objects import PermissionProfile


@dataclass(frozen=True, slots=True)
class CreateSessionCommand:
    """创建 Session 所需的用户输入。"""

    workspace_path: str | None
    default_model: str
    permission_profile: PermissionProfile
    project_id: UUID | None = None
