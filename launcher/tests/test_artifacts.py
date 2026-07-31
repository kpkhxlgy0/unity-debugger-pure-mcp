from __future__ import annotations

import base64
import hashlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / "launcher" / "scripts" / "verify_artifacts.py"
WHEEL_NAME = "unity_debugger_pure_mcp-0.1.0-py3-none-win_amd64.whl"
SDIST_NAME = "unity_debugger_pure_mcp-0.1.0.tar.gz"
DIST_INFO = "unity_debugger_pure_mcp-0.1.0.dist-info"
PACKAGE = "unity_debugger_pure_mcp_launcher"
SDIST_ROOT = "unity_debugger_pure_mcp-0.1.0"


class ArtifactVerifierTests(unittest.TestCase):
    def test_accepts_exact_launcher_artifacts(self) -> None:
        with artifact_directory() as directory:
            result = verify(directory)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_or_extra_artifacts(self) -> None:
        with artifact_directory() as directory:
            (directory / SDIST_NAME).unlink()
            self.assert_failed(directory, "exactly one wheel and one sdist")

        with artifact_directory() as directory:
            (directory / "extra.txt").write_text("extra", encoding="utf-8")
            self.assert_failed(directory, "unexpected launcher artifact")

    def test_rejects_traversal_and_case_collisions(self) -> None:
        with artifact_directory(
            wheel_mutation=lambda files: files.__setitem__("../escape.py", b"bad"),
        ) as directory:
            self.assert_failed(directory, "unsafe archive path")

        def add_collision(files: dict[str, bytes]) -> None:
            files[f"{PACKAGE}/MODEL.py"] = files[f"{PACKAGE}/model.py"]

        with artifact_directory(wheel_mutation=add_collision) as directory:
            self.assert_failed(directory, "duplicate archive path")

    def test_rejects_tampered_wheel_record(self) -> None:
        def tamper(files: dict[str, bytes]) -> None:
            files[f"{PACKAGE}/model.py"] += b"\n# changed after RECORD\n"

        with artifact_directory(wheel_mutation=tamper, preserve_record=True) as directory:
            self.assert_failed(directory, "RECORD hash mismatch")

    def test_rejects_wrong_wheel_tag(self) -> None:
        with artifact_directory(wheel_name="unity_debugger_pure_mcp-0.1.0-py3-none-any.whl") as directory:
            self.assert_failed(directory, "wheel filename")

    def test_rejects_injected_dependency(self) -> None:
        def inject(files: dict[str, bytes]) -> None:
            metadata = files[f"{DIST_INFO}/METADATA"].decode()
            files[f"{DIST_INFO}/METADATA"] = metadata.replace(
                "\n\n",
                "\nRequires-Dist: requests\n\n",
                1,
            ).encode()

        with artifact_directory(wheel_mutation=inject) as directory:
            self.assert_failed(directory, "runtime dependencies")

    def test_rejects_embedded_executable(self) -> None:
        with artifact_directory(
            wheel_mutation=lambda files: files.__setitem__(f"{PACKAGE}/node.exe", b"MZ"),
        ) as directory:
            self.assert_failed(directory, "unexpected wheel member")

    def test_rejects_raw_user_path_or_live_token(self) -> None:
        def leak(files: dict[str, bytes]) -> None:
            files[f"{PACKAGE}/model.py"] += (
                b'\nLEAK = "C:\\\\Users\\\\Admin\\\\build\\\\host.json '
                + b"A" * 43
                + b'"\n'
            )

        with artifact_directory(wheel_mutation=leak) as directory:
            self.assert_failed(directory, "sensitive build data")

    def test_rejects_tar_symlinks_and_special_files(self) -> None:
        with artifact_directory(sdist_extra=tar_member("link", tarfile.SYMTYPE)) as directory:
            self.assert_failed(directory, "unsupported tar member type")

        with artifact_directory(sdist_extra=tar_member("device", tarfile.CHRTYPE)) as directory:
            self.assert_failed(directory, "unsupported tar member type")

    def assert_failed(self, directory: Path, message: str) -> None:
        result = verify(directory)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message.lower(), result.stderr.lower())


class artifact_directory:
    def __init__(
        self,
        *,
        wheel_name: str = WHEEL_NAME,
        wheel_mutation=None,
        preserve_record: bool = False,
        sdist_extra: tarfile.TarInfo | None = None,
    ) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.path = Path(self._temporary.name)
        self._wheel_name = wheel_name
        self._wheel_mutation = wheel_mutation
        self._preserve_record = preserve_record
        self._sdist_extra = sdist_extra

    def __enter__(self) -> Path:
        wheel_files = valid_wheel_files()
        original_record = make_record(wheel_files)
        wheel_files[f"{DIST_INFO}/RECORD"] = original_record
        if self._wheel_mutation is not None:
            self._wheel_mutation(wheel_files)
            if not self._preserve_record:
                wheel_files[f"{DIST_INFO}/RECORD"] = make_record(
                    {key: value for key, value in wheel_files.items() if not key.endswith("/RECORD")},
                )
        with zipfile.ZipFile(self.path / self._wheel_name, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in wheel_files.items():
                archive.writestr(name, data)
        write_sdist(self.path / SDIST_NAME, self._sdist_extra)
        return self.path

    def __exit__(self, *_args: object) -> None:
        self._temporary.cleanup()


def valid_wheel_files() -> dict[str, bytes]:
    metadata = (
        "Metadata-Version: 2.4\n"
        "Name: unity-debugger-pure-mcp\n"
        "Version: 0.1.0\n"
        "Requires-Python: >=3.10\n"
        "License-File: LICENSE.txt\n"
        "Dynamic: license-file\n\n"
    ).encode()
    return {
        f"{PACKAGE}/__init__.py": b'__version__ = "0.1.0"\n',
        f"{PACKAGE}/__main__.py": b"def main():\n    return None\n",
        f"{PACKAGE}/discovery.py": b"def discover():\n    return None\n",
        f"{PACKAGE}/model.py": b"from dataclasses import dataclass\n",
        f"{DIST_INFO}/WHEEL": (
            "Wheel-Version: 1.0\n"
            "Generator: uv-build\n"
            "Root-Is-Purelib: true\n"
            "Tag: py3-none-win_amd64\n\n"
        ).encode(),
        f"{DIST_INFO}/entry_points.txt": (
            "[console_scripts]\n"
            "unity-debugger-pure-mcp = unity_debugger_pure_mcp_launcher.__main__:main\n"
        ).encode(),
        f"{DIST_INFO}/METADATA": metadata,
    }


def make_record(files: dict[str, bytes]) -> bytes:
    lines = []
    for name in sorted(files):
        digest = base64.urlsafe_b64encode(hashlib.sha256(files[name]).digest()).rstrip(b"=").decode()
        lines.append(f"{name},sha256={digest},{len(files[name])}")
    lines.append(f"{DIST_INFO}/RECORD,,")
    return ("\n".join(lines) + "\n").encode()


def write_sdist(path: Path, extra: tarfile.TarInfo | None) -> None:
    files = {
        "PKG-INFO": b"Metadata-Version: 2.4\nName: unity-debugger-pure-mcp\nVersion: 0.1.0\nRequires-Python: >=3.10\n",
        "pyproject.toml": b'[project]\nname = "unity-debugger-pure-mcp"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n',
        "pyproject.toml.orig": b'[project]\nname = "unity-debugger-pure-mcp"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n',
        "LICENSE.txt": b"MIT\n",
        "README.md": b"Launcher\n",
        f"src/{PACKAGE}/__init__.py": b'__version__ = "0.1.0"\n',
        f"src/{PACKAGE}/__main__.py": b"def main():\n    return None\n",
        f"src/{PACKAGE}/discovery.py": b"def discover():\n    return None\n",
        f"src/{PACKAGE}/model.py": b"from dataclasses import dataclass\n",
    }
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for relative, data in files.items():
            info = tarfile.TarInfo(f"{SDIST_ROOT}/{relative}")
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
        if extra is not None:
            extra.name = f"{SDIST_ROOT}/{extra.name}"
            archive.addfile(extra)


def tar_member(name: str, member_type: bytes) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = member_type
    if member_type == tarfile.SYMTYPE:
        info.linkname = "../escape"
    return info


def verify(directory: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, os.fspath(VERIFIER), os.fspath(directory)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


if __name__ == "__main__":
    unittest.main()
