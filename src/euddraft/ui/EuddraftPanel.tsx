/** The euddraft panel: the project folder, its settings file and sections, Compile, the log, the built map. */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AlertTriangle, FolderOpen, Hammer, RefreshCw, Save, Square, Play, X } from "lucide-react";
import { translate } from "../../i18n";
import { useT } from "../../i18n/react";
import type { EuddraftController, State } from "../controller";
import { sectionKind, wouldFreeze } from "../project";

export function EuddraftPanel({ controller, mapName }: { controller: EuddraftController; mapName: () => string | null }) {
  const t = useT();
  const s = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  const busy = s.phase === "compiling" || s.phase === "reading";
  const target = controller.target();

  return (
    <div className="edd-root">
      <section className="edd-row edd-folder">
        <FolderOpen size={14} className="edd-dim" />
        {s.folder
          ? <span className="edd-name" title={s.folder.name}>{s.folder.name}</span>
          : <span className="edd-dim">{t("No project folder yet")}</span>}
        <span className="edd-grow" />
        {s.folder?.kept && s.folder.access !== "granted" && (
          <button type="button" className="btn sm primary" onClick={() => void controller.reconnect()}>{t("Allow access")}</button>
        )}
        {s.folder?.kept && s.folder.access === "granted" && (
          <button type="button" className="btn icon sm ghost" title={t("Read the folder again")} disabled={busy} onClick={() => void controller.read()}><RefreshCw size={13} /></button>
        )}
        <button type="button" className="btn sm" disabled={busy} onClick={() => void controller.chooseFolder()}>{s.folder ? t("Change…") : t("Choose folder…")}</button>
        {s.folder && <button type="button" className="btn icon sm ghost" title={t("Forget this folder")} disabled={busy} onClick={() => void controller.forget()}><X size={13} /></button>}
      </section>

      {!s.folder && <Intro />}
      {s.folder && !s.folder.kept && s.files && (
        <p className="edd-note">{t("This browser cannot keep the folder: choose it again to pick up changes to its files.")}</p>
      )}

      {s.files && s.settingsPaths.length === 0 && (
        <p className="edd-note edd-warn">{t("The folder has no .eds or .edd settings file.")}</p>
      )}
      {s.settingsPaths.length > 1 && (
        <label className="edd-row">
          <span className="edd-dim">{t("Settings")}</span>
          <select className="select edd-grow" value={s.settingsPath ?? ""} disabled={busy} onChange={(e) => controller.selectSettings(e.target.value)}>
            {s.settingsPaths.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      )}
      {s.settings && s.settingsPath && <Sections state={s} />}

      {s.settings && wouldFreeze(s.settings) && (
        <p className="edd-note edd-warn"><AlertTriangle size={12} /> {t("euddraft would protect this map with freeze. The editor cannot apply freeze yet, so the map it builds is not protected. Add [freeze] with freeze : 0 to the settings to build without it on purpose.")}</p>
      )}

      {s.settingsPath && (
        <div className="edd-row edd-io">
          <span className="edd-dim">{t("Input")}</span>
          <span className="edd-name">{t("the map open in the editor ({name})", { name: mapName() ?? t("none open") })}</span>
        </div>
      )}
      {target && (
        <label className="check edd-row">
          <input type="checkbox" checked={s.writeIntoFolder} disabled={busy} onChange={(e) => controller.setWriteIntoFolder(e.target.checked)} />
          <span>{t("Write the built map to {path} in the folder", { path: target })}</span>
        </label>
      )}

      <div className="edd-row edd-actions">
        {s.phase === "compiling"
          ? <button type="button" className="btn sm danger" onClick={() => controller.stop()}><Square size={12} /> {t("Stop")}</button>
          : <button type="button" className="btn sm primary" disabled={busy || !s.settingsPath} onClick={() => void controller.compile()}><Hammer size={13} /> {t("Compile")}</button>}
        {s.built && s.phase === "done" && <>
          <button type="button" className="btn sm" onClick={() => void controller.saveAs()}><Save size={13} /> {t("Save As…")}</button>
          <button type="button" className="btn sm" onClick={() => void controller.test()}><Play size={13} /> {t("Test Map")}</button>
        </>}
        <span className="edd-grow" />
        <Status state={s} />
      </div>

      <Log state={s} />
    </div>
  );
}

function Intro() {
  const t = useT();
  return (
    <div className="edd-intro">
      <p>{t("Build the open map with euddraft: choose the folder that holds your .eds or .edd settings file and the .eps and .py plugins it names.")}</p>
      <p className="edd-dim">{t("Everything runs in this browser tab. The first compile loads about 15 MB (Python and eudplib) from this site.")}</p>
    </div>
  );
}

function Sections({ state }: { state: State }) {
  const t = useT();
  const files = new Set((state.files ?? []).map((f) => f.path));
  const entries = [...(state.settings?.sections ?? new Map()).entries()];
  return (
    <div className="edd-sections">
      <div className="edd-dim edd-small">{state.settingsPath}</div>
      {state.settings?.errors.map((e) => <div key={`e${e.line}`} className="edd-section edd-bad">{t("Line {line}: {message}", { line: e.line, message: e.message })}</div>)}
      {entries.map(([name, keys]) => {
        const kind = sectionKind(name, state.settingsPath!, files);
        const label =
          kind.kind === "main" ? t("main settings")
          : kind.kind === "freeze" ? (keys.has("freeze") ? t("freeze off") : t("freeze on"))
          : kind.kind === "builtin" ? t("handled by euddraft")
          : kind.kind === "bundled" ? t("bundled plugin")
          : kind.kind === "project" ? t("in the folder")
          : t("not found: {where}", { where: kind.looked });
        return (
          <div key={name} className={`edd-section${kind.kind === "missing" ? " edd-bad" : ""}`}>
            <span className="edd-section-name">[{name}]</span>
            <span className="edd-dim">{label}</span>
            {keys.size > 0 && <span className="edd-dim edd-small">{t("{n, plural, one {# setting} other {# settings}}", { n: keys.size })}</span>}
          </div>
        );
      })}
    </div>
  );
}

function Status({ state }: { state: State }) {
  const t = useT();
  if (state.phase === "compiling" || state.phase === "reading") {
    return <span className="status-line" role="status" aria-live="polite"><span className="spinner sm" aria-hidden="true" />{translate(state.stage || "Reading the project")}</span>;
  }
  if (state.phase === "failed") return <span className="edd-bad">{t("Failed")}</span>;
  if (state.phase === "done" && state.built) {
    const b = state.built;
    return (
      <span className="edd-ok" title={b.wrote ? t("Written to {path}", { path: b.wrote }) : undefined}>
        {b.wrote
          ? t("Built in {s} s, written to {path}", { s: (b.ms / 1000).toFixed(1), path: b.wrote })
          : t("Built in {s} s ({kb} KB scenario)", { s: (b.ms / 1000).toFixed(1), kb: Math.round(b.chkBytes / 1024) })}
      </span>
    );
  }
  return null;
}

function Log({ state }: { state: State }) {
  const t = useT();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [state.log.length, state.error]);
  if (!state.log.length && !state.error) return null;
  return (
    <div className="edd-log" role="log" aria-label={t("Build log")}>
      {state.log.map((line, i) => <div key={i} className={/\[Error|Error |Traceback|EPError|^freeze:/.test(line) ? "edd-log-bad" : /Warning/.test(line) ? "edd-log-warn" : undefined}>{line || " "}</div>)}
      {state.error && <>
        {/* The traceback folded away and the headline last, where the log is scrolled to: the
            compiler's own lines above it already say which file and line. */}
        {state.error.detail && (
          <details className="edd-log-detail">
            <summary>{t("Python traceback")}</summary>
            <pre>{state.error.detail}</pre>
          </details>
        )}
        <div className="edd-log-bad edd-log-head">{state.error.message}</div>
      </>}
      <div ref={end} />
    </div>
  );
}
