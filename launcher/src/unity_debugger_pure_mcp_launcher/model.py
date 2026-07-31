from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LaunchSelection:
    runtime_root: str
    client_root: str
    bridge_executable: str
