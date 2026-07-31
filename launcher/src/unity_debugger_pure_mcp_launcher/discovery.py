from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import re
import stat
import sys
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import LaunchSelection


NO_LIVE_MESSAGE = "No live Unity Debugger Pure MCP companion was found."
AMBIGUOUS_MESSAGE = "More than one live Unity Debugger Pure MCP companion matches this project."
INTEGRITY_MESSAGE = "Unity Debugger Pure MCP launcher integrity validation failed."
INCOMPATIBLE_MESSAGE = "The installed Unity Debugger Pure MCP companion uses an incompatible protocol."

MAX_RECORD_BYTES = 65_536
STALE_SECONDS = 45.0
FUTURE_SECONDS = 15.0
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259

_TOP_LEVEL_KEYS = {
    "schemaVersion",
    "instanceId",
    "ownerPid",
    "updatedAt",
    "workspaceRoots",
    "bridge",
    "pipe",
}
_BRIDGE_KEYS = {
    "version",
    "protocolVersion",
    "extensionRoot",
    "executable",
    "sha256",
}
_PIPE_KEYS = {"name", "token"}
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)
_PIPE_PREFIX = "\\\\.\\pipe\\unity-debugger-pure-mcp-"


class NoLiveCompanionError(RuntimeError):
    def __init__(self, *_details: object) -> None:
        super().__init__(NO_LIVE_MESSAGE)


class AmbiguousCompanionError(RuntimeError):
    def __init__(self, *_details: object) -> None:
        super().__init__(AMBIGUOUS_MESSAGE)


class IntegrityError(RuntimeError):
    def __init__(self, *_details: object) -> None:
        super().__init__(INTEGRITY_MESSAGE)


class IncompatibleProtocolError(RuntimeError):
    def __init__(self, *_details: object) -> None:
        super().__init__(INCOMPATIBLE_MESSAGE)


def resolve_runtime_root(environ: Mapping[str, str]) -> str:
    local_app_data = environ.get("LOCALAPPDATA", "")
    if not _valid_path(local_app_data):
        raise IntegrityError()
    return os.path.realpath(
        os.path.join(
            local_app_data,
            "kpk",
            "unity-debugger-pure-mcp",
            "runtime",
            "v1",
        )
    )


def path_contains(root: str, candidate: str) -> bool:
    try:
        canonical_root = os.path.normcase(os.path.normpath(root))
        canonical_candidate = os.path.normcase(os.path.normpath(candidate))
        return os.path.commonpath([canonical_root, canonical_candidate]) == canonical_root
    except (OSError, ValueError):
        return False


def discover(
    cwd: str,
    environ: Mapping[str, str],
    *,
    now: datetime | None = None,
    process_alive: Callable[[int], bool] = None,
) -> LaunchSelection:
    if process_alive is None:
        process_alive = windows_process_alive
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)
    else:
        current_time = current_time.astimezone(timezone.utc)
    runtime_root = resolve_runtime_root(environ)
    client_root = os.path.realpath(cwd)
    if not _valid_path(client_root) or not os.path.isdir(client_root):
        raise IntegrityError()

    try:
        entries = sorted(Path(runtime_root).iterdir(), key=lambda entry: entry.name)
    except OSError:
        raise NoLiveCompanionError()

    matches: list[LaunchSelection] = []
    saw_integrity_failure = False
    saw_incompatible_protocol = False
    for entry in entries:
        if entry.suffix.lower() != ".json":
            continue
        try:
            record = _read_record(entry)
        except IncompatibleProtocolError:
            saw_incompatible_protocol = True
            continue
        except (IntegrityError, OSError, UnicodeError, json.JSONDecodeError):
            continue

        if not _is_current(record, current_time, process_alive):
            continue
        roots = _canonical_workspace_roots(record["workspaceRoots"])
        if roots is None or not any(path_contains(root, client_root) for root in roots):
            continue
        try:
            executable = _verified_bridge(record["bridge"])
        except IncompatibleProtocolError:
            saw_incompatible_protocol = True
            continue
        except (IntegrityError, OSError):
            saw_integrity_failure = True
            continue
        matches.append(
            LaunchSelection(
                runtime_root=runtime_root,
                client_root=client_root,
                bridge_executable=executable,
            )
        )

    if len(matches) > 1:
        raise AmbiguousCompanionError()
    if len(matches) == 1:
        return matches[0]
    if saw_integrity_failure:
        raise IntegrityError()
    if saw_incompatible_protocol:
        raise IncompatibleProtocolError()
    raise NoLiveCompanionError()


def windows_process_alive(pid: int) -> bool:
    if sys.platform != "win32" or type(pid) is not int or pid <= 0:
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _read_record(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise IntegrityError()
    size = path.stat().st_size
    if size <= 0 or size > MAX_RECORD_BYTES:
        raise IntegrityError()
    with path.open("rb") as source:
        raw = source.read(MAX_RECORD_BYTES + 1)
    if len(raw) != size or len(raw) > MAX_RECORD_BYTES:
        raise IntegrityError()
    value = json.loads(raw.decode("utf-8", errors="strict"))
    if not isinstance(value, dict):
        raise IntegrityError()
    schema_version = value.get("schemaVersion")
    if type(schema_version) is not int:
        raise IntegrityError()
    if schema_version != 1:
        raise IncompatibleProtocolError()
    if set(value) != _TOP_LEVEL_KEYS:
        raise IntegrityError()
    if not _valid_record(value):
        raise IntegrityError()
    return value


def _valid_record(value: dict[str, Any]) -> bool:
    bridge = value.get("bridge")
    pipe = value.get("pipe")
    roots = value.get("workspaceRoots")
    return (
        isinstance(value.get("instanceId"), str)
        and _UUID_PATTERN.fullmatch(value["instanceId"]) is not None
        and type(value.get("ownerPid")) is int
        and 0 < value["ownerPid"] <= 0x7FFF_FFFF
        and isinstance(value.get("updatedAt"), str)
        and _parse_timestamp(value["updatedAt"]) is not None
        and isinstance(roots, list)
        and 0 < len(roots) <= 32
        and all(_valid_path(root) for root in roots)
        and isinstance(bridge, dict)
        and set(bridge) == _BRIDGE_KEYS
        and isinstance(bridge.get("version"), str)
        and _VERSION_PATTERN.fullmatch(bridge["version"]) is not None
        and type(bridge.get("protocolVersion")) is int
        and _valid_path(bridge.get("extensionRoot"))
        and _valid_path(bridge.get("executable"))
        and isinstance(bridge.get("sha256"), str)
        and _SHA256_PATTERN.fullmatch(bridge["sha256"]) is not None
        and isinstance(pipe, dict)
        and set(pipe) == _PIPE_KEYS
        and isinstance(pipe.get("name"), str)
        and pipe["name"].startswith(_PIPE_PREFIX)
        and len(pipe["name"]) <= 512
        and _valid_token(pipe.get("token"))
    )


def _is_current(
    record: dict[str, Any],
    now: datetime,
    process_alive: Callable[[int], bool],
) -> bool:
    updated_at = _parse_timestamp(record["updatedAt"])
    if updated_at is None:
        return False
    age = (now - updated_at).total_seconds()
    return (
        age <= STALE_SECONDS
        and age >= -FUTURE_SECONDS
        and process_alive(record["ownerPid"])
    )


def _canonical_workspace_roots(values: list[str]) -> list[str] | None:
    roots: list[str] = []
    try:
        for value in values:
            root = os.path.realpath(value)
            if not os.path.isdir(root):
                return None
            roots.append(root)
    except OSError:
        return None
    return roots


def _verified_bridge(value: dict[str, Any]) -> str:
    if value["protocolVersion"] != 1:
        raise IncompatibleProtocolError()
    extension_root = os.path.realpath(value["extensionRoot"])
    executable = os.path.realpath(value["executable"])
    expected = os.path.realpath(
        os.path.join(extension_root, "dist", "mcp-bridge.exe")
    )
    if (
        not path_contains(extension_root, expected)
        or not _same_path(executable, expected)
        or os.path.islink(value["executable"])
    ):
        raise IntegrityError()
    file_status = os.stat(executable, follow_symlinks=False)
    if not stat.S_ISREG(file_status.st_mode):
        raise IntegrityError()
    if _sha256(executable) != value["sha256"]:
        raise IntegrityError()
    return executable


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while True:
            chunk = source.read(65_536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _valid_path(value: object) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 4_096
        and "\0" not in value
        and os.path.isabs(value)
    )


def _valid_token(value: object) -> bool:
    if not isinstance(value, str) or _TOKEN_PATTERN.fullmatch(value) is None:
        return False
    try:
        return len(base64.urlsafe_b64decode(value + "=")) == 32
    except (ValueError, TypeError):
        return False


def _parse_timestamp(value: str) -> datetime | None:
    if _TIMESTAMP_PATTERN.fullmatch(value) is None:
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None
    return parsed


def _same_path(left: str, right: str) -> bool:
    return os.path.normcase(os.path.normpath(left)) == os.path.normcase(
        os.path.normpath(right)
    )
