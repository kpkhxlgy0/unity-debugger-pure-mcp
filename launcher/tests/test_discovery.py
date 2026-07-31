from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from unity_debugger_pure_mcp_launcher.discovery import (
    AMBIGUOUS_MESSAGE,
    INCOMPATIBLE_MESSAGE,
    INTEGRITY_MESSAGE,
    NO_LIVE_MESSAGE,
    AmbiguousCompanionError,
    IncompatibleProtocolError,
    IntegrityError,
    NoLiveCompanionError,
    discover,
    path_contains,
    resolve_runtime_root,
    windows_process_alive,
)


NOW = datetime(2026, 7, 31, 6, 0, 0, tzinfo=timezone.utc)
TOKEN = "I" * 43


class DiscoveryFixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="udp mcp 启动器 ",
        )
        self.base = Path(self.temporary.name)
        self.local_app_data = self.base / "Local App Data"
        self.runtime_root = (
            self.local_app_data
            / "kpk"
            / "unity-debugger-pure-mcp"
            / "runtime"
            / "v1"
        )
        self.workspace = self.base / "Unity Project 测试"
        self.client = self.workspace / "Nested Root"
        self.extension = self.base / "extension"
        self.bridge = self.extension / "dist" / "mcp-bridge.exe"
        self.runtime_root.mkdir(parents=True)
        self.client.mkdir(parents=True)
        self.bridge.parent.mkdir(parents=True)
        self.bridge.write_bytes(b"verified bridge fixture")
        self.live_pids = {4242}

    def close(self) -> None:
        self.temporary.cleanup()

    def record(self, **overrides: object) -> dict[str, object]:
        record: dict[str, object] = {
            "schemaVersion": 1,
            "instanceId": "55555555-5555-4555-8555-555555555555",
            "ownerPid": 4242,
            "updatedAt": NOW.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "workspaceRoots": [str(self.workspace.resolve())],
            "bridge": {
                "version": "0.1.0",
                "protocolVersion": 1,
                "extensionRoot": str(self.extension.resolve()),
                "executable": str(self.bridge.resolve()),
                "sha256": hashlib.sha256(self.bridge.read_bytes()).hexdigest(),
            },
            "pipe": {
                "name": "\\\\.\\pipe\\unity-debugger-pure-mcp-super-secret-pipe",
                "token": TOKEN,
            },
        }
        merge(record, overrides)
        return record

    def write(self, record: dict[str, object], name: str = "record.json") -> None:
        (self.runtime_root / name).write_text(json.dumps(record), encoding="utf-8")

    def discover(self):
        return discover(
            str(self.client),
            {"LOCALAPPDATA": str(self.local_app_data)},
            now=NOW,
            process_alive=lambda pid: pid in self.live_pids,
        )


def merge(target: dict[str, object], overrides: dict[str, object]) -> None:
    for key, value in overrides.items():
        current = target.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merge(current, value)
        else:
            target[key] = value


class DiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = DiscoveryFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_discovers_one_canonical_live_registration(self) -> None:
        self.fixture.write(self.fixture.record())
        selection = self.fixture.discover()
        self.assertEqual(selection.runtime_root, os.path.realpath(self.fixture.runtime_root))
        self.assertEqual(selection.client_root, os.path.realpath(self.fixture.client))
        self.assertEqual(selection.bridge_executable, os.path.realpath(self.fixture.bridge))

    def test_resolves_runtime_root_only_from_local_app_data(self) -> None:
        expected = self.fixture.runtime_root
        self.assertEqual(
            resolve_runtime_root({"LOCALAPPDATA": str(self.fixture.local_app_data)}),
            os.path.realpath(expected),
        )
        with self.assertRaises(IntegrityError):
            resolve_runtime_root({})

    def test_rejects_oversize_and_non_strict_records(self) -> None:
        oversized = self.fixture.runtime_root / "oversized.json"
        oversized.write_bytes(b"{" + (b"x" * 65_536))
        record = self.fixture.record(unexpected=True)
        self.fixture.write(record, "extra-key.json")
        with self.assertRaisesRegex(NoLiveCompanionError, NO_LIVE_MESSAGE):
            self.fixture.discover()

    def test_discards_stale_future_and_dead_owners(self) -> None:
        for index, updated_at in enumerate((
            NOW - timedelta(seconds=45, milliseconds=1),
            NOW + timedelta(seconds=15, milliseconds=1),
        )):
            record = self.fixture.record(
                updatedAt=updated_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            )
            self.fixture.write(record, f"time-{index}.json")
        self.fixture.write(self.fixture.record(ownerPid=7000), "dead.json")
        with self.assertRaises(NoLiveCompanionError):
            self.fixture.discover()

    def test_rejects_no_match_and_two_valid_matches(self) -> None:
        outside = self.fixture.base / "outside"
        outside.mkdir()
        self.fixture.write(self.fixture.record(workspaceRoots=[str(outside)]))
        with self.assertRaises(NoLiveCompanionError):
            self.fixture.discover()

        (self.fixture.runtime_root / "record.json").unlink()
        self.fixture.write(self.fixture.record(), "one.json")
        second = self.fixture.record(instanceId="66666666-6666-4666-8666-666666666666")
        self.fixture.write(second, "two.json")
        with self.assertRaisesRegex(AmbiguousCompanionError, AMBIGUOUS_MESSAGE):
            self.fixture.discover()

    def test_accepts_case_differences_and_rejects_other_drive(self) -> None:
        self.fixture.write(
            self.fixture.record(workspaceRoots=[str(self.fixture.workspace).swapcase()]),
        )
        self.assertEqual(self.fixture.discover().client_root, os.path.realpath(self.fixture.client))
        self.assertFalse(path_contains("C:\\workspace", "D:\\workspace\\project"))

    def test_rejects_hash_path_and_non_file_integrity_failures(self) -> None:
        cases = [
            {"bridge": {"sha256": "a" * 64}},
            {"bridge": {"executable": str(self.fixture.base / "other.exe")}},
        ]
        for index, overrides in enumerate(cases):
            self.fixture.write(self.fixture.record(**overrides), f"invalid-{index}.json")
        with self.assertRaisesRegex(IntegrityError, INTEGRITY_MESSAGE):
            self.fixture.discover()

        for entry in self.fixture.runtime_root.glob("*.json"):
            entry.unlink()
        directory_record = self.fixture.record()
        self.fixture.bridge.unlink()
        self.fixture.bridge.mkdir()
        self.fixture.write(directory_record)
        with self.assertRaises(IntegrityError):
            self.fixture.discover()

    def test_rejects_incompatible_schema_and_protocol(self) -> None:
        self.fixture.write(self.fixture.record(schemaVersion=2), "schema.json")
        self.fixture.write(
            self.fixture.record(bridge={"protocolVersion": 2}),
            "protocol.json",
        )
        with self.assertRaisesRegex(IncompatibleProtocolError, INCOMPATIBLE_MESSAGE):
            self.fixture.discover()

    def test_rejects_booleans_that_masquerade_as_protocol_integers(self) -> None:
        self.fixture.write(self.fixture.record(schemaVersion=True))
        with self.assertRaises(NoLiveCompanionError):
            self.fixture.discover()

        (self.fixture.runtime_root / "record.json").unlink()
        self.fixture.write(self.fixture.record(bridge={"protocolVersion": True}))
        with self.assertRaises(NoLiveCompanionError):
            self.fixture.discover()

    def test_rejects_a_junction_or_symlink_escape(self) -> None:
        outside = self.fixture.base / "outside-extension"
        outside.mkdir()
        outside_bridge = outside / "mcp-bridge.exe"
        outside_bridge.write_bytes(self.fixture.bridge.read_bytes())
        escaped = self.fixture.extension / "escaped"
        try:
            os.symlink(outside, escaped, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory link unavailable: {error.__class__.__name__}")
        record = self.fixture.record(
            bridge={
                "extensionRoot": str(self.fixture.extension),
                "executable": str(escaped / "mcp-bridge.exe"),
                "sha256": hashlib.sha256(outside_bridge.read_bytes()).hexdigest(),
            },
        )
        self.fixture.write(record)
        with self.assertRaises(IntegrityError):
            self.fixture.discover()

    def test_public_exception_messages_are_sanitized(self) -> None:
        for exception in (
            NoLiveCompanionError(),
            AmbiguousCompanionError(),
            IntegrityError(),
            IncompatibleProtocolError(),
        ):
            rendered = str(exception)
            self.assertNotIn(TOKEN, rendered)
            self.assertNotIn("super-secret-pipe", rendered)
            self.assertNotIn(str(self.fixture.base), rendered)

    def test_windows_pid_probe_observes_current_and_missing_process(self) -> None:
        self.assertTrue(windows_process_alive(os.getpid()))
        self.assertFalse(windows_process_alive(0x7FFF_FFFE))


if __name__ == "__main__":
    unittest.main()
