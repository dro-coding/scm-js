# From scm-js/plugin-eudplib v0.6.0 (python/mpqshim.py), MIT, copyright 2026 scmJS; unchanged.
"""A stand-in for eudplib.bindings._rust.mpqapi (the StormLib wrapper) that never touches an
archive: the host registers the members of the input map by path, and collects what eudplib
adds to the output. Same eight methods eudplib's maprw calls, nothing more."""
import os

_archives: dict[str, "MPQ"] = {}


def register(path: str, files: dict[str, bytes], names: list[str]) -> None:
    """The input map at `path`: its members (name → bytes, the readable copy) and listfile names."""
    _archives[path] = MPQ({(_key(n), 0): b for n, b in files.items()}, list(names))


def collect(path: str) -> list[tuple[str, int, bytes]]:
    """Everything eudplib wrote to the output map at `path`, in order: (name, locale, bytes)."""
    return [(n, loc, b) for (n, loc), b in _archives[path].files.items()]


def _key(name: str) -> str:
    return name.replace("/", "\\").lower()


class MPQ:
    def __init__(self, files, names):
        self.files: dict[tuple[str, int], bytes] = files
        self.names = names
        self.locale = 0
        self.max_files = 1024

    @staticmethod
    def open(path: str) -> "MPQ":
        return _archives[path]

    @staticmethod
    def create(path: str, sector_size: int, file_count: int) -> "MPQ":
        m = MPQ({}, []); m.max_files = file_count; _archives[path] = m; return m

    @staticmethod
    def clone_with_sector_size(src: str, dst: str, sector_size: int) -> "MPQ":
        s = _archives[src]
        # eudplib re-adds scenario.chk itself; every other member rides along unchanged.
        m = MPQ({k: v for k, v in s.files.items() if k[0] != "staredit\\scenario.chk"}, list(s.names))
        _archives[dst] = m
        return m

    def get_file_names_from_listfile(self) -> list[str]:
        return list(self.names)

    def extract_file(self, name: str) -> bytes:
        k = _key(name)
        for (n, loc), b in self.files.items():
            if n == k and loc == self.locale:
                return b
        for (n, _loc), b in self.files.items():
            if n == k:
                return b
        raise OSError(f"no such member: {name}")

    def set_file_locale(self, locale: int) -> None:
        self.locale = locale

    def get_max_file_count(self) -> int:
        return self.max_files

    def set_max_file_count(self, count: int) -> None:
        self.max_files = count

    def add_file(self, name: str, path: str) -> None:
        with open(path, "rb") as f:
            self.files[(_key(name), self.locale)] = f.read()

    def compact(self) -> None:
        pass
