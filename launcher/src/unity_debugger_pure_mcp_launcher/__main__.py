from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import NoReturn, TextIO

from .discovery import (
    AMBIGUOUS_MESSAGE,
    INCOMPATIBLE_MESSAGE,
    INTEGRITY_MESSAGE,
    NO_LIVE_MESSAGE,
    AmbiguousCompanionError,
    IncompatibleProtocolError,
    IntegrityError,
    NoLiveCompanionError,
    discover,
)
from .model import LaunchSelection


WINDOWS_REQUIRED_MESSAGE = "Unity Debugger Pure MCP launcher requires Windows."

EXIT_WINDOWS_REQUIRED = 2
EXIT_NO_LIVE = 3
EXIT_AMBIGUOUS = 4
EXIT_INTEGRITY = 5
EXIT_INCOMPATIBLE = 6


def exec_bridge(selection: LaunchSelection) -> NoReturn:
    completed = subprocess.run(
        [
            selection.bridge_executable,
            "--registry",
            selection.runtime_root,
            "--client-root",
            selection.client_root,
        ],
        check=False,
        shell=False,
    )
    raise SystemExit(completed.returncode)


def main(
    argv: Sequence[str] | None = None,
    *,
    platform: str | None = None,
    stderr: TextIO | None = None,
    cwd: str | None = None,
    environ: Mapping[str, str] | None = None,
    discover_fn: Callable[..., LaunchSelection] = discover,
    exec_fn: Callable[[LaunchSelection], NoReturn] = exec_bridge,
) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    platform_name = sys.platform if platform is None else platform
    error_stream = sys.stderr if stderr is None else stderr
    if platform_name != "win32":
        _write_error(error_stream, WINDOWS_REQUIRED_MESSAGE)
        return EXIT_WINDOWS_REQUIRED
    if arguments:
        _write_error(error_stream, INTEGRITY_MESSAGE)
        return EXIT_INTEGRITY
    try:
        selection = discover_fn(
            os.getcwd() if cwd is None else cwd,
            os.environ if environ is None else environ,
        )
        exec_fn(selection)
    except NoLiveCompanionError:
        _write_error(error_stream, NO_LIVE_MESSAGE)
        return EXIT_NO_LIVE
    except AmbiguousCompanionError:
        _write_error(error_stream, AMBIGUOUS_MESSAGE)
        return EXIT_AMBIGUOUS
    except IncompatibleProtocolError:
        _write_error(error_stream, INCOMPATIBLE_MESSAGE)
        return EXIT_INCOMPATIBLE
    except (IntegrityError, OSError, RuntimeError):
        _write_error(error_stream, INTEGRITY_MESSAGE)
        return EXIT_INTEGRITY
    except Exception:
        _write_error(error_stream, INTEGRITY_MESSAGE)
        return EXIT_INTEGRITY
    _write_error(error_stream, INTEGRITY_MESSAGE)
    return EXIT_INTEGRITY


def _write_error(stream: TextIO, message: str) -> None:
    stream.write(f"{message}\n")


if __name__ == "__main__":
    raise SystemExit(main())
