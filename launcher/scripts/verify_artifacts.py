from __future__ import annotations

import base64
import configparser
import csv
from email.parser import BytesParser
from email.policy import compat32
import hashlib
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import zipfile


VERSION = "0.1.0"
PROJECT = "unity_debugger_pure_mcp"
PACKAGE = "unity_debugger_pure_mcp_launcher"
WHEEL_NAME = f"{PROJECT}-{VERSION}-py3-none-win_amd64.whl"
SDIST_NAME = f"{PROJECT}-{VERSION}.tar.gz"
DIST_INFO = f"{PROJECT}-{VERSION}.dist-info"
SDIST_ROOT = f"{PROJECT}-{VERSION}"

WHEEL_FILES = {
    f"{PACKAGE}/__init__.py",
    f"{PACKAGE}/__main__.py",
    f"{PACKAGE}/discovery.py",
    f"{PACKAGE}/model.py",
    f"{DIST_INFO}/WHEEL",
    f"{DIST_INFO}/entry_points.txt",
    f"{DIST_INFO}/METADATA",
    f"{DIST_INFO}/RECORD",
}
WHEEL_DIRECTORIES = {f"{PACKAGE}/", f"{DIST_INFO}/"}
SDIST_FILES = {
    f"{SDIST_ROOT}/PKG-INFO",
    f"{SDIST_ROOT}/pyproject.toml",
    f"{SDIST_ROOT}/pyproject.toml.orig",
    f"{SDIST_ROOT}/LICENSE.txt",
    f"{SDIST_ROOT}/README.md",
    f"{SDIST_ROOT}/src/{PACKAGE}/__init__.py",
    f"{SDIST_ROOT}/src/{PACKAGE}/__main__.py",
    f"{SDIST_ROOT}/src/{PACKAGE}/discovery.py",
    f"{SDIST_ROOT}/src/{PACKAGE}/model.py",
}
SDIST_DIRECTORIES = {
    SDIST_ROOT,
    f"{SDIST_ROOT}/src",
    f"{SDIST_ROOT}/src/{PACKAGE}",
}
WINDOWS_USER_PATH = re.compile(rb"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s\"']+", re.IGNORECASE)
LIVE_TOKEN = re.compile(rb"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])")


class VerificationError(ValueError):
    pass


def verify_artifacts(directory: Path) -> None:
    if not directory.is_dir():
        raise VerificationError("Launcher artifact directory does not exist.")
    entries = sorted(path for path in directory.iterdir())
    expected = {WHEEL_NAME, SDIST_NAME}
    actual = {path.name for path in entries}
    if actual != expected:
        wheels = sorted(name for name in actual if name.endswith(".whl"))
        if wheels and wheels != [WHEEL_NAME]:
            raise VerificationError("Invalid wheel filename or platform tag.")
        unexpected = sorted(actual - expected)
        if unexpected:
            raise VerificationError(f"Unexpected launcher artifact: {unexpected[0]}")
        raise VerificationError("Expected exactly one wheel and one sdist.")
    verify_wheel(directory / WHEEL_NAME)
    verify_sdist(directory / SDIST_NAME)


def verify_wheel(path: Path) -> None:
    if path.name != WHEEL_NAME:
        raise VerificationError("Invalid wheel filename or platform tag.")
    with zipfile.ZipFile(path) as archive:
        files: dict[str, bytes] = {}
        directories: set[str] = set()
        seen: set[str] = set()
        for entry in archive.infolist():
            name = _safe_member_name(entry.filename)
            _reject_duplicate(name, seen)
            if entry.is_dir():
                directories.add(name)
            else:
                if entry.create_system == 3:
                    mode = entry.external_attr >> 16
                    if mode and not stat.S_ISREG(mode):
                        raise VerificationError(f"Unsupported ZIP member type: {name}")
                files[name] = archive.read(entry)
        unexpected_files = sorted(set(files) - WHEEL_FILES)
        missing_files = sorted(WHEEL_FILES - set(files))
        unexpected_directories = sorted(directories - WHEEL_DIRECTORIES)
        if unexpected_files:
            raise VerificationError(f"Unexpected wheel member: {unexpected_files[0]}")
        if missing_files:
            raise VerificationError(f"Missing wheel member: {missing_files[0]}")
        if unexpected_directories:
            raise VerificationError(f"Unexpected wheel member: {unexpected_directories[0]}")

        wheel = _metadata(files[f"{DIST_INFO}/WHEEL"])
        if wheel.get("Root-Is-Purelib") != "true":
            raise VerificationError("Wheel must declare Root-Is-Purelib: true.")
        if wheel.get_all("Tag", []) != ["py3-none-win_amd64"]:
            raise VerificationError("Wheel platform tag must be py3-none-win_amd64.")
        metadata = _metadata(files[f"{DIST_INFO}/METADATA"])
        _verify_project_metadata(metadata)
        if not _valid_entry_point(files[f"{DIST_INFO}/entry_points.txt"]):
            raise VerificationError("Wheel console entry point is invalid.")
        _verify_record(files)
        _verify_no_sensitive_data(files)


def verify_sdist(path: Path) -> None:
    with tarfile.open(path, "r:gz") as archive:
        files: dict[str, bytes] = {}
        directories: set[str] = set()
        seen: set[str] = set()
        for member in archive.getmembers():
            name = _safe_member_name(member.name)
            _reject_duplicate(name, seen)
            if member.isdir():
                directories.add(name.rstrip("/"))
                continue
            if not member.isfile():
                raise VerificationError(f"Unsupported tar member type: {name}")
            stream = archive.extractfile(member)
            if stream is None:
                raise VerificationError(f"Cannot read tar member: {name}")
            files[name] = stream.read()
        unexpected_files = sorted(set(files) - SDIST_FILES)
        missing_files = sorted(SDIST_FILES - set(files))
        unexpected_directories = sorted(directories - SDIST_DIRECTORIES)
        if unexpected_files:
            raise VerificationError(f"Unexpected sdist member: {unexpected_files[0]}")
        if missing_files:
            raise VerificationError(f"Missing sdist member: {missing_files[0]}")
        if unexpected_directories:
            raise VerificationError(f"Unexpected sdist member: {unexpected_directories[0]}")
        _verify_project_metadata(_metadata(files[f"{SDIST_ROOT}/PKG-INFO"]))
        for pyproject_name in ("pyproject.toml", "pyproject.toml.orig"):
            pyproject = files[f"{SDIST_ROOT}/{pyproject_name}"].decode("utf-8")
            _verify_pyproject(pyproject)
        _verify_no_sensitive_data(files)


def _verify_project_metadata(metadata) -> None:
    if metadata.get_all("Name", []) != ["unity-debugger-pure-mcp"]:
        raise VerificationError("Package name is invalid.")
    if metadata.get_all("Version", []) != [VERSION]:
        raise VerificationError("Package version is invalid.")
    if metadata.get_all("Requires-Python", []) != [">=3.10"]:
        raise VerificationError("Package must require Python >=3.10.")
    if metadata.get_all("Requires-Dist", []):
        raise VerificationError("Launcher must have zero runtime dependencies.")


def _verify_pyproject(contents: str) -> None:
    requirements = {
        "name": 'name = "unity-debugger-pure-mcp"',
        "version": 'version = "0.1.0"',
        "requires-python": 'requires-python = ">=3.10"',
        "dependencies": "dependencies = []",
    }
    lines = [line.strip() for line in contents.splitlines()]
    for key, expected in requirements.items():
        assignments = [line for line in lines if re.match(rf"^{re.escape(key)}\s*=", line)]
        if assignments != [expected]:
            if key == "dependencies":
                raise VerificationError("sdist must have zero runtime dependencies.")
            raise VerificationError(f"sdist project {key} is invalid.")


def _verify_record(files: dict[str, bytes]) -> None:
    record_name = f"{DIST_INFO}/RECORD"
    rows = list(csv.reader(files[record_name].decode("utf-8").splitlines()))
    recorded: dict[str, tuple[str, str]] = {}
    for row in rows:
        if len(row) != 3 or row[0] in recorded:
            raise VerificationError("Wheel RECORD is malformed.")
        recorded[row[0]] = (row[1], row[2])
    if set(recorded) != set(files):
        raise VerificationError("Wheel RECORD file list mismatch.")
    for name, contents in files.items():
        digest, size = recorded[name]
        if name == record_name:
            if digest or size:
                raise VerificationError("Wheel RECORD must not hash itself.")
            continue
        expected_digest = base64.urlsafe_b64encode(hashlib.sha256(contents).digest()).rstrip(b"=").decode()
        if digest != f"sha256={expected_digest}" or size != str(len(contents)):
            raise VerificationError(f"RECORD hash mismatch: {name}")


def _verify_no_sensitive_data(files: dict[str, bytes]) -> None:
    for name, contents in files.items():
        if name.endswith("/RECORD"):
            continue
        if WINDOWS_USER_PATH.search(contents) or LIVE_TOKEN.search(contents):
            raise VerificationError(f"Sensitive build data found in artifact member: {name}")


def _safe_member_name(raw_name: str) -> str:
    name = raw_name.replace("\\", "/")
    pure = PurePosixPath(name)
    if (
        not name
        or name.startswith("/")
        or re.match(r"^[A-Za-z]:", name)
        or ".." in pure.parts
        or "." in pure.parts
    ):
        raise VerificationError(f"Unsafe archive path: {raw_name}")
    return name


def _reject_duplicate(name: str, seen: set[str]) -> None:
    key = name.rstrip("/").casefold()
    if key in seen:
        raise VerificationError(f"Duplicate archive path: {name}")
    seen.add(key)


def _metadata(contents: bytes):
    return BytesParser(policy=compat32).parsebytes(contents)


def _valid_entry_point(contents: bytes) -> bool:
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    try:
        parser.read_string(contents.decode("utf-8"))
    except configparser.Error:
        return False
    return (
        parser.sections() == ["console_scripts"]
        and dict(parser.items("console_scripts"))
        == {
            "unity-debugger-pure-mcp":
                "unity_debugger_pure_mcp_launcher.__main__:main",
        }
    )


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1:
        print("Usage: verify_artifacts.py <artifact-directory>", file=sys.stderr)
        return 2
    try:
        verify_artifacts(Path(arguments[0]))
    except (OSError, VerificationError, tarfile.TarError, zipfile.BadZipFile, UnicodeError) as error:
        print(f"Launcher artifact verification failed: {error}", file=sys.stderr)
        return 1
    print(f"Verified launcher wheel and sdist in {arguments[0]}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
