"""eudplib's epScript compiler, answered by a WebAssembly build of the same C++ source.

eudplib opens `libepScriptLib` with ctypes the first time an .eps file is compiled
(`eudplib/epscript/epscompile.py`) and calls seven functions on it. Pyodide cannot open
that library, so `install()` puts an object with the same seven calls in its place. The
compiler itself is `epscript.wasm`, built from eudplib's own `src/epscript` at the release
the wheel was made from (`scripts/build-epscript.mjs`); the worker loads it and registers
it as the JS module `_epscript_wasm`. eudplib's Python is not changed: `epsCompile` still
reads the result through `c_char_p(address).value`, so the result is handed back as the
address of a ctypes buffer that lives until eudplib frees it.
"""
import ctypes

from pyodide.ffi import to_js

_REGISTER = {"plib": 0, "keywords": 1, "builtins": 2}


class WasmEpScript:
    def __init__(self, js):
        self._js = js
        self._results = {}

    def compileString(self, filename, code):  # noqa: N802 - the C library's names
        out = self._js.compile(to_js(bytes(filename)), to_js(bytes(code)))
        if out is None:
            return None
        buf = ctypes.create_string_buffer(out.to_bytes())
        address = ctypes.addressof(buf)
        self._results[address] = buf
        return address

    def freeCompiledResult(self, address):  # noqa: N802
        self._results.pop(address, None)

    def getErrorCount(self):  # noqa: N802
        return int(self._js.errorCount())

    def setDebugMode(self, on):  # noqa: N802
        self._js.setDebugMode(1 if on else 0)

    def registerPlibConstants(self, names):  # noqa: N802
        self._js.register(_REGISTER["plib"], to_js(bytes(names)))

    def registerPyKeywords(self, names):  # noqa: N802
        self._js.register(_REGISTER["keywords"], to_js(bytes(names)))

    def registerPyBuiltins(self, names):  # noqa: N802
        self._js.register(_REGISTER["builtins"], to_js(bytes(names)))


def install():
    """After `import eudplib`: the names eudplib registered while it was imported are
    waiting in `epscompile`'s pending slots, since no library was open yet."""
    import _epscript_wasm
    from eudplib.epscript import epscompile

    lib = WasmEpScript(_epscript_wasm)
    pending = (
        (epscompile._pending_plib_constants, lib.registerPlibConstants),
        (epscompile._pending_py_keywords, lib.registerPyKeywords),
        (epscompile._pending_py_builtins, lib.registerPyBuiltins),
    )
    for names, register in pending:
        if names is not None:
            register(names)
    epscompile._libeps = lib
