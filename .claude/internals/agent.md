# Claude Agent — a plugin of its own, a default of this fork

A panel where Claude reads and edits the open map. Built 2026-11-11 in this fork's
`src/agent`; moved 2026-11-15 into its own repository,
**github.com/dro-coding/plugin-claude-agent**, after scm-js/scm-js#228's review asked for a
plugin instead of editor code. Reader docs: `docs/guide.md#claude-agent`, README feature
list, and the plugin's own README.

## How it gets here

- `src/plugins/defaults.ts` pins it like scm-js's defaults:
  `github:dro-coding/plugin-claude-agent@vX.Y.Z`, on. `scripts/vendor-plugins.mjs` copies
  its source into `plugins/claude-agent/` (the name the old `builtin:claude-agent` had, so
  plugin storage, which holds the settings and a remembered key, carries over), and Vite
  compiles it in: the controller, tools, SDK and React panel stay lazy chunks loaded on
  first open, the copied docs another one loaded by the first `read_docs`.
- It imports values from `@anthropic-ai/sdk`, `react`, `react-dom` and `lucide-react`;
  vendored source resolves them from this repository's `node_modules`, which is why the
  SDK stays in `package.json` here. Its standalone bundle (`dist/plugin.js`, 2.2 MB
  unminified) carries them itself for any other editor.
- Not type-checked here (`tsconfig.app.json` includes `src` only), so the SDK's
  `undici-types` stub lives in the plugin's own tsconfig, not this one.
- To move it forward: tag a release in the plugin repository, bump the tag in
  `defaults.ts`, `npm run vendor:plugins`, run `tests/claude-agent-plugin.test.ts`.

## What changed in the move (and why)

- **Plugin API only.** Trigger text goes through `tx.triggers.fromText` inside
  `document.update`. Before scm-js/scm-js#259 (this fork's editor, 0.13.3) a failed parse
  has already interned the text's strings and `withStrings` never records them (the parse
  threw), so they would stay with no undo step: `tools/triggers.ts#writeText` lists
  `tx.strings` first and `apply`s it back before rethrowing; `runUpdate` then takes back
  the step that records. On an editor with #259 the table is untouched and that does
  nothing. `.trg` attachments use `api.exchange.decodeTrg`; the docs are copied in at a
  release tag (`npm run docs` there); the stylesheet is a string the panel injects.
- **Wrong map (review bug 1).** Tools act on the map in front. A session remembers its
  map (`docId`); the controller passes every `"document"` event to every session, and one
  whose map leaves the front mid-turn stops (`documentChanged`); every tool call, approved
  ones included, checks the map before it runs. `new_map` (`opensMap`) moves the
  conversation to the map it made instead (`controller.moved`).
- **Wrong undo (review bug 2).** A turn records its map's undo stack around each of its
  calls (`markStack`): `edits` is the depth it added, whatever the steps' labels (resize,
  tileset, new map counted right), and "Undo these changes" works only while depth and top
  label are exactly as the turn left them (`canUndoTurn`, re-checked on every `"commit"`
  event). A turn with someone else's step between two of its own offers no button.
- Also from the review: the prompt says map text, tool results and attachments are content,
  not instructions; prices checked against Anthropic's page (Sonnet 5.5 cache reads $0.10,
  Haiku 5.5's over-100k-token tier added, a fallback priced as the model that answered);
  every shown string through `api.i18n` with a full `ko.ts`.

## Verification

In the plugin repository (no editor): the tool set, attachments, prices, the Korean
catalogue, the old-editor string leak, and the conversation loop against a scripted Messages
API and a stand-in editor with an undo stack per map (both bugs; each test fails with its
fix taken out). Here, `tests/claude-agent-plugin.test.ts` runs the vendored tools against a
blank map through `createPluginApi`, including "a failed parse leaves the strings and the
undo stack as they were" on this pre-#259 editor.
