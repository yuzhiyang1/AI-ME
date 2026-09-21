"""浏览器授权按会话和站点隔离，不能继承另一个站点的授权。"""

from urllib.parse import urlsplit


def browser_origin(value: object) -> str:
    """只接受不带内嵌账号的 HTTP(S) URL，统一默认端口与主机大小写。"""
    if not isinstance(value, str) or len(value) > 4000:
        raise ValueError("请提供有效的浏览器网址")
    url = urlsplit(value)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
        raise ValueError("浏览器仅允许无内嵌凭据的 HTTP(S) 网址")
    host = url.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    port = url.port
    suffix = f":{port}" if port and port != (443 if url.scheme == "https" else 80) else ""
    return f"{url.scheme}://{host}{suffix}"


def tool_grant_scope(name: str, arguments: dict[str, object]) -> str:
    """浏览器共用站点授权；其他工具维持原有按工具名授权的语义。"""
    if not name.startswith("browser_"):
        return name
    origin = browser_origin(arguments.get("url" if name == "browser_navigate" else "origin"))
    return f"browser:{origin}"
