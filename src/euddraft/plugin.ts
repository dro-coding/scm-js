/**
 * euddraft — a built-in plugin of this fork: build the open map with euddraft from a
 * project folder (the .eds / .edd settings, the .eps and .py plugins, euddraft's bundled
 * ones), in the browser. Tools ▸ euddraft… opens a floating panel; the panel's code, and
 * the runtime the first compile loads, cost nothing until then.
 *
 * How it builds: `engine.ts` (Pyodide + the eudplib wheel + euddraft's own loader and
 * plugins + epScript compiled to WebAssembly), run by `worker.ts`, one fresh worker per
 * build (`runner.ts`). See `.claude/internals/euddraft.md`.
 */
import type { PanelHandle, PluginApi } from "../plugins/api";
import type { EuddraftController } from "./controller";

export function activate(api: PluginApi): () => void {
  let panel: PanelHandle | null = null;
  let controller: Promise<EuddraftController> | null = null;

  const load = (): Promise<EuddraftController> => {
    controller ??= import("./controller").then((m) => new m.EuddraftController(api));
    return controller;
  };

  const open = () => {
    if (panel?.isOpen()) return;
    panel = api.ui.panel({
      title: "euddraft",
      dock: "float",
      width: 460,
      height: Math.max(380, Math.min(640, Math.round(window.innerHeight * 0.66))),
      resizable: true,
      maximizable: true,
      mount(body) {
        let cleanup: (() => void) | null = null;
        let gone = false;
        void Promise.all([load(), import("./ui/mount")]).then(([c, ui]) => {
          if (!gone) cleanup = ui.mountEuddraft(body, c, () => { const info = api.document.info(); return info ? info.fileName ?? info.name : null; });
        }).catch((err) => {
          body.textContent = `The euddraft panel could not load: ${err instanceof Error ? err.message : String(err)}`;
        });
        return () => { gone = true; cleanup?.(); };
      },
      onClose: () => { panel = null; },
    });
  };

  const toggle = () => (panel?.isOpen() ? panel.close() : open());
  api.menu.add("Tools", { label: "euddraft…", icon: "plugin", run: toggle });
  api.commands.register({ id: "open", title: "euddraft", run: open });

  return () => {
    panel?.close();
    void controller?.then((c) => c.dispose());
  };
}
