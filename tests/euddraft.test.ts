/**
 * The euddraft compiler (`src/euddraft/`): the settings reader and the project paths the
 * panel shows, the epScript compiler's WebAssembly build behind eudplib's C calls, and a
 * whole build under Node — Pyodide from the `pyodide` package standing in for the runtime
 * folder the web build serves — on a project with an .eps that imports another .eps, a
 * .py plugin and one of euddraft's bundled plugins, then on one whose .eps does not parse.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleMap, splitMap } from "../src/euddraft/archive";
import { bootEngine, epscriptBridge, safeProjectPath, type EngineSources, type EpScriptModule, type Pyodide } from "../src/euddraft/engine";
import {
  joinProjectPath, outputName, outputPath, parseSettings, sectionKind, settingsFiles, wouldFreeze,
} from "../src/euddraft/project";
import createEpScript from "../src/euddraft/runtime/epscript.mjs";

const E = join(import.meta.dirname, "..", "src", "euddraft");
const enc = (s: string) => new TextEncoder().encode(s);

describe("the settings file, read as euddraft's readconfig reads it", () => {
  const text = [
    "\uFEFF[main]",
    "input : ../map.scx",
    "output= ../out/built.scx",
    ":: a comment",
    "",
    "[main.eps]",
    "[src\\:odd.py]",
    "[MSQC]",
    "xy\\:z : 3",
    "keyonly",
    "[main]",
    "[freeze]",
    "freeze : 0",
    "stray line without a colon ]",
  ].join("\r\n");
  const s = parseSettings(text);

  it("keeps sections in order, with values, bare keys and escapes", () => {
    expect([...s.sections.keys()]).toEqual(["main", "main.eps", "src\\:odd.py", "MSQC", "main_dup", "freeze"]);
    expect(s.sections.get("main")!.get("input")).toBe("../map.scx");
    expect(s.sections.get("main")!.get("output")).toBe("../out/built.scx");
    expect(s.sections.get("MSQC")!.get("xy:z")).toBe("3");
    expect(s.sections.get("MSQC")!.get("keyonly")).toBe("");
    expect(s.errors.map((e) => e.line)).toEqual([11]);
  });

  it("knows when euddraft would freeze", () => {
    expect(wouldFreeze(s)).toBe(false);
    expect(wouldFreeze(parseSettings("[main]\n[freeze]\nprompt\n"))).toBe(true);
    expect(wouldFreeze(parseSettings("[main]\n"))).toBe(true);
  });

  it("finds each section's plugin from the settings file's folder", () => {
    const files = new Set(["src/main.edd", "src/Main.eps", "src/lib/helper.py"]);
    expect(sectionKind("main.eps", "src/main.edd", files)).toEqual({ kind: "project", path: "src/main.eps" });
    expect(sectionKind("lib/helper.py", "src/main.edd", files)).toEqual({ kind: "project", path: "src/lib/helper.py" });
    expect(sectionKind("other.eps", "src/main.edd", files)).toMatchObject({ kind: "missing" });
    expect(sectionKind("MSQC", "src/main.edd", files)).toEqual({ kind: "bundled" });
    expect(sectionKind("myGlobalPlugin", "src/main.edd", files)).toMatchObject({ kind: "missing" });
    expect(sectionKind("main", "x.eds", files).kind).toBe("main");
    expect(sectionKind("freeze", "x.eds", files).kind).toBe("freeze");
  });

  it("resolves paths inside the project and refuses the ones that leave it", () => {
    expect(joinProjectPath("src", "../out/a.scx")).toBe("out/a.scx");
    expect(joinProjectPath("", "../a.scx")).toBeNull();
    expect(outputPath(s, "src/main.edd")).toBe("out/built.scx");
    expect(outputPath(parseSettings("[main]\noutput: C:\\maps\\x.scx\n"), "a.eds")).toBeNull();
    expect(outputName(s, "map.scx")).toBe("built.scx");
    expect(outputName(null, "My Map.scm")).toBe("My Map_eud.scx");
    expect(settingsFiles(["b/x.edd", "a.eds", "readme.txt", "A.EDD"])).toEqual(["A.EDD", "a.eds", "b/x.edd"]);
    expect(safeProjectPath("a\\b/./c.eps")).toBe("a/b/c.eps");
    expect(safeProjectPath("../x")).toBeNull();
    expect(safeProjectPath("")).toBeNull();
  });
});

describe("epScript as WebAssembly", () => {
  let eps: ReturnType<typeof epscriptBridge>;
  const errors: string[] = [];
  beforeAll(async () => {
    const mod = (await createEpScript({ print: () => {}, printErr: (l: string) => errors.push(l) })) as EpScriptModule;
    eps = epscriptBridge(mod);
  });

  it("compiles epScript to eudplib Python", () => {
    const out = eps.compile(enc("t.eps"), enc("var x = 0;\nfunction onPluginStart() {\n    x = 3;\n}\n"));
    expect(out).not.toBeNull();
    expect(eps.errorCount()).toBe(0);
    const py = new TextDecoder().decode(out!);
    expect(py).toContain("from eudplib import");
    expect(py).toMatch(/def onPluginStart\(\)/);
  });

  it("reports a syntax error with its line and counts it", () => {
    // Like the native library, it may still return text: eudplib's epsCompile treats any
    // error count as a failure.
    errors.length = 0;
    eps.compile(enc("bad.eps"), enc("function f() {\n    var x = 1\n    x += ;\n}\n"));
    expect(eps.errorCount()).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/Line 3/);
  });
});

describe("a whole build under Node", () => {
  const read = (p: string) => readFileSync(join(E, p), "utf8");
  const modules = (dir: string) => Object.fromEntries(readdirSync(join(E, dir)).filter((f) => f.endsWith(".py")).map((f) => [f.slice(0, -3), read(join(dir, f))]));
  const sources: EngineSources = {
    driver: read("python/driver.py"), mpqshim: read("python/mpqshim.py"), epsshim: read("python/epsshim.py"),
    pluginLoader: read("vendor/euddraft/pluginLoader.py"), readconfig: read("vendor/euddraft/readconfig.py"),
    plugins: modules("vendor/euddraft/plugins"), lib: modules("vendor/euddraft/lib"),
  };
  const map = new Uint8Array(readFileSync(join(import.meta.dirname, "maps", "ums.scx")));

  async function engine(log: string[]) {
    const out = (line: string) => log.push(line);
    const py = (await loadPyodide({ stdout: out, stderr: out })) as unknown as Pyodide;
    const eps = (await createEpScript({ print: out, printErr: out })) as EpScriptModule;
    const wheels = readdirSync(join(E, "runtime")).filter((f) => f.endsWith(".whl")).sort((a, b) => Number(b.startsWith("typing_")) - Number(a.startsWith("typing_")));
    // Forward slashes: loadPackage reads the wheel's name, version and tags after the last one.
    return bootEngine({ py, eps, sources, wheels: wheels.map((w) => join(E, "runtime", w).replace(/\\/g, "/")) });
  }

  it("builds .eps (importing another .eps), .py and a bundled plugin into the map", async () => {
    const log: string[] = [];
    const split = await splitMap(map);
    const project = [
      { path: "src/main.edd", data: enc("[main]\ninput: ../in.scx\noutput: ../built.scx\n\n[main.eps]\n[helper.py]\n[eudTurbo]\n") },
      { path: "src/main.eps", data: enc("import lib.counter as counter;\n\nvar ticks = 0;\nfunction onPluginStart() { counter.reset(); }\nfunction beforeTriggerExec() {\n    ticks += 1;\n    if (ticks >= 240) { ticks = 0; counter.bump(); }\n}\n") },
      { path: "src/lib/counter.eps", data: enc("var count = 0;\nfunction reset() { count = 0; }\nfunction bump() { count += 1; }\n") },
      { path: "src/helper.py", data: enc("from eudplib import *\n\ndef onPluginStart():\n    DoActions(SetResources(P1, Add, 50, Ore))\n") },
    ];
    const result = (await engine(log)).build({ map, chk: split.chk, names: split.names, project, settings: "src/main.edd" });
    if (!result.ok) throw new Error(`${result.message}\n${result.detail}\n${log.join("\n")}`);
    expect(result.output).toBe("../built.scx");
    expect(result.freezeSkipped).toBe(true);
    expect(log.join("\n")).toMatch(/Compiling "lib\/counter\.eps"/);
    expect(log.join("\n")).toMatch(/Loading plugin eudTurbo/);
    const built = await assembleMap(result.members, split.extras);
    expect(built.chk.length).toBeGreaterThan(split.chk.length + 100_000);
    expect((await splitMap(built.map)).chk).toEqual(built.chk);
  }, 120_000);

  it("fails readably on an .eps that does not parse", async () => {
    const log: string[] = [];
    const split = await splitMap(map);
    const project = [
      { path: "main.eds", data: enc("[main]\ninput: a.scx\noutput: b.scx\n[freeze]\nfreeze : 0\n[broken.eps]\n") },
      { path: "broken.eps", data: enc("function beforeTriggerExec() {\n    var x = 1\n    x += ;\n}\n") },
    ];
    const result = (await engine(log)).build({ map, chk: split.chk, names: split.names, project, settings: "main.eds" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('Error loading plugin "broken.eps": Compiled failed for broken.eps');
    expect(log.join("\n")).toMatch(/Module "broken" Line 3 : General syntax error/);
    expect(log.join("\n")).not.toMatch(/^freeze:/m);
  }, 120_000);
});
