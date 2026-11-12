"""euddraft's apply step, for the editor's build worker.

This is `applyEUDDraft` from euddraft's `applyeuddraft.py` (v0.11.0.1), with what a
browser cannot or should not do taken out:

- [main] `input` is the map open in the editor and [main] `output` a file the worker
  hands back to the editor; the names the settings file gives are only reported.
- freeze is not applied. Its archive half (`freezeMpq`) is native code, so a project that
  euddraft would protect is built without it, and the log says so before anything else.
- no message boxes, beeps, `pause` prompts or update check.

Everything else is euddraft's own: `readconfig` parses the settings file, `pluginLoader`
loads the plugins (euddraft's bundled ones from /ed/plugins, the project's .eps and .py
files beside the settings file), and the [main] options are applied as applyeuddraft
applies them.
"""
import importlib
import os
import platform
import re
import sys
import traceback
import types
import warnings

MAIN_OPTIONS = (
    "input",
    "output",
    "shufflePayload",
    "debug",
    "decodeUnitName",
    "objFieldN",
    "sectorSize",
    "ptrEUDArray",
    "errorReapplyEPD",
    "suppressWarnings",
)

_SITE_PACKAGES = None


def prepare(site_packages: str) -> None:
    """Load the Rust extension before the eudplib package and give it the pure-Python
    archive API (`mpqshim`); then import eudplib and put the WebAssembly epScript compiler
    where it looks for its native one (`epsshim`). The wasm wheel is built without
    StormLib, so `_rust` has no `mpqapi` of its own."""
    global _SITE_PACKAGES
    _SITE_PACKAGES = os.path.join(site_packages, "eudplib")
    import mpqshim

    # epscript/epscompile.py indexes a {"Windows", "Linux", "Darwin"} table by
    # platform.system() at import time; the library it names is never opened here.
    platform.system = lambda: "Linux"
    fake = types.ModuleType("eudplib")
    fake.__path__ = [_SITE_PACKAGES]
    sys.modules["eudplib"] = fake
    rust = importlib.import_module("eudplib.bindings._rust")
    rust.mpqapi = mpqshim
    del sys.modules["eudplib"]
    import eudplib  # noqa: F401 - the real package, now that its extension is set up
    import epsshim

    epsshim.install()


def _payload_main(ep, hooks):
    """euddraft's `createPayloadMain`, freeze left out."""

    @ep.EUDFunc
    def payloadMain():  # noqa: N802 - euddraft's name
        for on_start in hooks.get("onPluginStart", []):
            on_start()
        if ep.EUDInfLoop()():
            for before in hooks.get("beforeTriggerExec", []):
                before()
            ep.RunTrigTrigger()
            for after in reversed(hooks.get("afterTriggerExec", [])):
                after()
            ep.EUDDoEvents()
        ep.EUDEndInfLoop()

    return payloadMain


_RICH = re.compile(r"\[(?:/|red|on red|bright_black)\]")


def build(*, ed_dir: str, project_dir: str, settings: str, in_path: str, out_path: str) -> dict:
    """Build `in_path` into `out_path` as the settings file `settings` (an .eds or .edd,
    relative to `project_dir`) says. euddraft runs with the settings file's folder as the
    working directory and first on `sys.path`; so does this."""
    lib_dir = os.path.join(ed_dir, "lib")
    for path in (ed_dir, lib_dir):
        if path not in sys.path:
            sys.path.append(path)
    settings_dir, settings_name = os.path.split(os.path.join(project_dir, settings))
    os.chdir(settings_dir)
    sys.path.insert(0, settings_dir)

    import eudplib as ep
    from eudplib.collections.objpool import SetGlobalPoolFieldN
    from eudplib.core.mapdata.tblformat import DecodeUnitNameAs
    from eudplib.epscript.epsimp import IsSCDBMap
    from eudplib.utils.eperror import ep_warn
    from pluginLoader import loadPluginsFromConfig, suppress_warnings
    from readconfig import readconfig

    config, excs = readconfig(settings_name)
    if excs:
        for exc in excs:
            print(_RICH.sub("", str(exc)), file=sys.stderr)
        raise RuntimeError("error(s) on eds/edd configuration")
    if "main" not in config:
        raise RuntimeError(f"{settings_name} has no [main] section.")

    main = config["main"]
    asked_output = main.get("output", "")
    main["input"] = in_path
    main["output"] = out_path

    unused = [key for key in main if key not in MAIN_OPTIONS]
    if unused:
        ep_warn(f"Unused manifest keys in [main]: {', '.join(unused)}")

    # pluginLoader freezes unless [freeze] carries a `freeze` key ("freeze : 0").
    freeze_skipped = not ("freeze" in config and "freeze" in config["freeze"])
    if freeze_skipped:
        print(
            "freeze: euddraft would protect this map with freeze. The editor cannot apply "
            "freeze (it is native code), so the map is built WITHOUT it.",
            file=sys.stderr,
        )
        config.setdefault("freeze", {})["freeze"] = "0"

    if "shufflePayload" in main:
        ep.ShufflePayload(eval(main["shufflePayload"]))
    if "ptrEUDArray" in main:
        from eudplib.collections.eudarray import _use_ptr_array

        if eval(main["ptrEUDArray"]):
            _use_ptr_array()
    if "errorReapplyEPD" in main:
        from eudplib.utils.etc import _allow_epd_on_epd

        _allow_epd_on_epd(not eval(main["errorReapplyEPD"]))
    if "suppressWarnings" in main:
        suppress_warnings(True)
        warnings.filterwarnings("ignore")
        warnings.filterwarnings("ignore", category=DeprecationWarning)
    if "debug" in main:
        ep.EPS_SetDebug(True)
    if "decodeUnitName" in main:
        DecodeUnitNameAs(main["decodeUnitName"])
    if "objFieldN" in main:
        SetGlobalPoolFieldN(int(main["objFieldN"]))
    sector_size = int(main["sectorSize"]) if "sectorSize" in main else 15

    print("---------- Loading plugins... ----------")
    ep.LoadMap(in_path)
    hooks = loadPluginsFromConfig(ep, config)

    print("--------- Injecting plugins... ---------")
    if IsSCDBMap():
        print("SCDB - sectorSize disabled")
        sector_size = None
    payload = _payload_main(ep, hooks)
    ep.CompressPayload(True)
    ep.SaveMap(out_path, payload, sector_size=sector_size)
    return {"output": asked_output, "freezeSkipped": freeze_skipped}


def describe(exc: BaseException, project_dir: str, ed_dir: str) -> tuple[str, str]:
    """The failure as euddraft prints it: the message, and the traceback without the frames
    inside eudplib and this driver (euddraft's `isEpExc`), unless nothing else is left."""
    plugins_dir = os.path.join(ed_dir, "plugins")

    def internal(entry: str) -> bool:
        s = entry
        return (
            (_SITE_PACKAGES is not None and _SITE_PACKAGES in s)
            or "/py/" in s
            or 'File "<exec>"' in s
            or (ed_dir in s and plugins_dir not in s)
            or "<frozen " in s
            or "runpy.py" in s
        )

    entries = traceback.format_exception(type(exc), exc, exc.__traceback__)
    kept = []
    for i, entry in enumerate(entries):
        if internal(entry) and not all(internal(e) for e in entries[i + 1 : -1]):
            continue
        kept.append(entry.replace(project_dir + "/", ""))

    def said(e: BaseException) -> str:
        return _RICH.sub("", str(e)).strip().lstrip("- ").strip() or type(e).__name__

    # pluginLoader re-raises every plugin's failure as 'Error loading plugin "x"'; the
    # reason is the exception it was handling, so the headline carries both.
    inner = exc
    while (inner.__cause__ or inner.__context__) is not None:
        inner = inner.__cause__ or inner.__context__
    message = said(exc) if inner is exc else f"{said(exc)}: {said(inner)}"
    return message.replace(project_dir + "/", ""), "".join(kept)
