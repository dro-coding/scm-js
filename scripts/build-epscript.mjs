/**
 * `node scripts/build-epscript.mjs --eudplib <checkout> [--emsdk <dir>] [--out <dir>] [--test]`
 * — build epScript, eudplib's compiler for `.eps` files, as WebAssembly for the euddraft
 * build (`src/euddraft/`).
 *
 * eudplib calls epScript through seven C functions in a native library it opens with
 * ctypes (`libepScriptLib`). The Pyodide wheel the editor runs has no such library, so this
 * builds the same C++ (`src/epscript` of the eudplib release the wheel was made from) with
 * Emscripten into `epscript.mjs` + `epscript.wasm`, which the build worker loads and
 * `src/euddraft/python/epsshim.py` puts where eudplib looks. The output is committed in
 * `src/euddraft/runtime/`; nothing in `npm run build` needs Emscripten.
 *
 * What it does, in eudplib's own CMakeLists.txt order:
 * 1. builds lemon2 (the parser generator eudplib ships as C) for Node and generates the
 *    parser from `parser/epparser.lemon`, refusing a header whose tokens differ from the
 *    one eudplib commits;
 * 2. compiles the library's sources and `libmain.cpp` (the seven exports) into an ES
 *    module for a worker or Node;
 * 3. with `--test`, also builds eudplib's own epScript unit tests (Catch) from the same
 *    sources and flags and runs them under Node — a failing assertion fails the script.
 *
 * Needs the Emscripten SDK (https://emscripten.org/docs/getting_started/downloads.html),
 * `--emsdk` or `$EMSDK`; 5.0.3 made the committed files. The checkout:
 *   git clone --depth 1 --branch v0.81.0 https://github.com/armoha/eudplib
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const eudplib = option("--eudplib");
const emsdk = option("--emsdk") ?? process.env.EMSDK;
const out = resolve(option("--out") ?? join(ROOT, "src", "euddraft", "runtime"));
const withTests = flag("--test");
if (!eudplib || !emsdk) {
  console.error("usage: node scripts/build-epscript.mjs --eudplib <eudplib checkout> [--emsdk <emsdk dir>] [--out <dir>] [--test]");
  process.exit(2);
}

const win = process.platform === "win32";
const tool = (name) => join(emsdk, "upstream", "emscripten", win ? `${name}.bat` : name);
/** Run a program; on Windows the Emscripten tools are .bat files, which only cmd runs. */
function run(cmd, argv, cwd) {
  const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const r = win
    ? spawnSync([cmd, ...argv].map(quote).join(" "), { cwd, stdio: "inherit", shell: true })
    : spawnSync(cmd, argv, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${relative(cwd, cmd) || cmd} exited with ${r.status ?? r.signal}`);
}

const src = resolve(eudplib, "src", "epscript");
if (!existsSync(join(src, "libmain.cpp"))) throw new Error(`${src} is not eudplib's src/epscript`);
for (const t of ["emcc", "em++"]) if (!existsSync(tool(t))) throw new Error(`no ${t} in ${emsdk}`);

const work = mkdtempSync(join(tmpdir(), "epscript-"));
try {
  cpSync(src, work, {
    recursive: true,
    filter: (p) => {
      const rel = p.slice(src.length).replace(/\\/g, "/");
      return !/^\/(pybind11|cmake-build|build)(\/|$)/.test(rel) && (withTests || !/^\/test(\/|$)/.test(rel));
    },
  });
  mkdirSync(out, { recursive: true });

  // 1. The parser.
  run(tool("emcc"), ["-O2", "-w", "-sNODERAWFS=1", "-sEXIT_RUNTIME=1", "-o", "lemon2.js", "lemon2.c"], work);
  const committed = readFileSync(join(work, "parser", "epparser.h"), "utf8");
  run(process.execPath, ["lemon2.js", "-p", "-c", "-l", "parser/epparser.lemon"], work);
  renameSync(join(work, "parser", "epparser.c"), join(work, "parser", "epparser.cpp"));
  const lf = (s) => s.replace(/\r\n/g, "\n");
  if (lf(readFileSync(join(work, "parser", "epparser.h"), "utf8")) !== lf(committed)) {
    throw new Error("lemon2 made a different parser/epparser.h from eudplib's: the tokenizer's token numbers would not match.");
  }

  // 2. The library: CMakeLists.txt's SOURCE_FILES (headers left out) and libmain.cpp.
  const sources = [
    "parser/epparser.cpp", "parser/tokenizer/tokenizer.cpp", "parser/tokenizer/tokChars.cpp",
    "parser/tokenizer/tokenizerImpl.cpp", "parser/generator/pygen.cpp", "parser/tokenAdapter.cpp",
    "parser/reservedWords/condact.cpp", "parser/generator/eudplibGlobals.cpp", "parser/generator/closure.cpp",
    "parser/parserUtils.cpp", "parser/parserUtilsTokens.cpp", "utils.cpp", "parser/reservedWords/constparser.cpp",
    "parser/utils/subTokenUtils.cpp", "parser/utils/traceUtils.cpp", "parser/tokenizer/token.cpp",
  ];
  for (const s of sources) if (!existsSync(join(work, s))) throw new Error(`eudplib's sources changed: no ${s}`);
  const exports = ["compileString", "freeCompiledResult", "setDebugMode", "getErrorCount",
    "registerPlibConstants", "registerPyKeywords", "registerPyBuiltins", "malloc", "free"];
  // The compiler throws std::runtime_error for a bad file and catches it in compileString,
  // so C++ exceptions stay on (JavaScript-based: every browser runs them).
  const common = ["-std=c++11", "-fexceptions", "-sDISABLE_EXCEPTION_CATCHING=0", "-sALLOW_MEMORY_GROWTH=1"];
  run(tool("em++"), [
    ...common, "-O2", ...sources, "libmain.cpp", "-o", join(out, "epscript.mjs"),
    "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createEpScript", "-sENVIRONMENT=worker,node", "-sFILESYSTEM=0",
    `-sEXPORTED_FUNCTIONS=${exports.map((f) => `_${f}`).join(",")}`,
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8",
  ], work);

  // 3. eudplib's own tests of the same sources (CMakeLists.txt's TEST_SOURCE_FILES).
  if (withTests) {
    const tests = [
      "test/test_tokenizer.cpp", "test/test_pygen.cpp", "test/test_base.cpp", "test/parser/test_arraydecl.cpp",
      "test/parser/test_complex.cpp", "test/parser/test_ctrlstru.cpp", "test/parser/test_globalv.cpp",
      "test/parser/test_import.cpp", "test/parser/test_object.cpp", "test/parser/test_ternary.cpp",
      "test/parser/test_pyliteral.cpp", "test/parser/test_expression.cpp", "test/test_testtool.cpp",
      "test/parser/test_function.cpp", "test/parser/test_lambda.cpp", "test/parser/test_debuginfo.cpp",
      "test/parser/test_staticv.cpp", "test/parser/test_bugcase_4.cpp", "test/parser/test_arrw_inc.cpp", "test/testmain.cpp",
    ];
    run(tool("em++"), [...common, "-O1", "-w", "-DMEMORY_DEBUG", ...sources, ...tests,
      "-sNODERAWFS=1", "-sEXIT_RUNTIME=1", "-sSTACK_SIZE=8MB", "-o", "epScriptTest.js"], work);
    run(process.execPath, ["epScriptTest.js"], work);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

for (const f of ["epscript.mjs", "epscript.wasm"]) {
  const bytes = readFileSync(join(out, f));
  console.log(`${relative(ROOT, join(out, f))}  ${bytes.length} bytes  sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
}
