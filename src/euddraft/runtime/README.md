# The euddraft runtime

What the euddraft compiler (`src/euddraft/`) loads the first time a map is compiled. None
of it is built by `npm run build`: the files are committed, and the build only serves them.

| File | Bytes | sha256 | Where it comes from |
| --- | --- | --- | --- |
| `eudplib-0.81.0-cp314-abi3-pyemscripten_2026_0_wasm32.whl` | 993,692 | `a50d55ea92d51c21446640ac9764495d3970d0b5b3af2e8fafd17165830aeb83` | eudplib 0.81.0 built for Pyodide 314 by [scm-js/plugin-eudplib](https://github.com/scm-js/plugin-eudplib) v0.6.0 (`dist/`; recipe in its `wheel/`: StormLib off, no epScript library, eudplib's Python unchanged) |
| `typing_extensions-4.15.0-py3-none-any.whl` | 44,613 | `4fec68770a05408e668a4fa53d6bf4f0f684b9dacf820c7c5d6e97d3ad225e29` | Pyodide 314.0.7's distribution (`cdn.jsdelivr.net/pyodide/v314.0.7/full/`) |
| `epscript.wasm` | 445,620 | `33fabeca93a2da31ddc4fd85945c3a0ecc9828b62e84c065745ef1f2c33f05ee` | eudplib v0.81.0's `src/epscript`, unchanged, built with Emscripten 5.0.3 by `scripts/build-epscript.mjs` |
| `epscript.mjs` | 21,845 | `0c90679d96e6b9938866a63348a08c838a4c4c5c2ba483077a776d07cbfffab2` | the loader Emscripten generated with it |
| `epscript.d.mts` | | | its types, by hand |
| `licenses/` | | | the license texts of all of the above, for `THIRD-PARTY-NOTICES.txt` (`scripts/lib/notices.mjs`) |

Pyodide itself (314.0.7, the version the wheel is built for) comes from the `pyodide` npm
package. `vite.config.ts` (`euddraftRuntime`) serves its five core files and the two
wheels from `plugin-runtime/euddraft/<hash>/` — together because Pyodide looks for its
files beside `pyodide.mjs`, under their own names because `loadPackage` reads a wheel's
name and tags from its file name. `epscript.wasm` is an ordinary hashed Vite asset.

## Rebuilding epScript

```sh
git clone --depth 1 --branch v0.81.0 https://github.com/armoha/eudplib
node scripts/build-epscript.mjs --eudplib ./eudplib --emsdk <emsdk dir> --test
```

The Emscripten SDK: `git clone https://github.com/emscripten-core/emsdk`, then
`emsdk install 5.0.3` and `emsdk activate 5.0.3`. `--test` also builds eudplib's own
epScript tests (Catch, 278 assertions) from the same sources and runs them under Node.
Built twice from the same checkout, `epscript.wasm` came out byte-identical. The script
prints each output's size and sha256; update the table above.

A newer eudplib needs a new wheel as well (plugin-eudplib's `wheel/` recipe) and the
matching euddraft files in `../vendor/euddraft/`: euddraft pins the eudplib minor version
it works with (`eudplib>=0.81.0,<0.82` for euddraft 0.11).
