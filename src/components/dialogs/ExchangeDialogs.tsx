import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ClipboardPaste, Download, FileText, Upload } from "lucide-react";
import { commitSettingsAtom, commitTriggersAtom, locationsRevisionAtom, scenarioAtom, settingsRevisionAtom, triggersRevisionAtom } from "../../atoms/documentAtoms";
import { pluginTriggerClaimsAtom } from "../../atoms/pluginAtoms";
import { locateClaims } from "../../plugins/claims";
import { mapDescriptionAtom, mapFilePathAtom, mapNameAtom } from "../../atoms/editorAtoms";
import { closeDialogAtom, pushToastAtom, statusMessageAtom } from "../../atoms/uiAtoms";
import {
  applyStringImport, encodeTrg, formatStringTable, parsePastedTriggers, parseStringTable, readTriggerFile, replaceWithPasted, triggersToText,
  type PastedTriggers, type TriggerFileFormat,
} from "../../editor/exchange";
import type { Scenario } from "../../formats/chk/scenario";
import { applyBriefing, applyTriggers } from "../../editor/triggers";
import { hostTerms } from "../../editor/platform";
import { getString } from "../../formats/chk/sections/strings";
import type { TriggerRecord } from "../../formats/chk/sections/triggers";
import { saveBytes } from "../../services/mapIo";
import { Button, Check, Field, Group, Select, TextArea } from "../ui";
import DialogFrame from "../ui/DialogFrame";
import type { DialogProps } from "./DialogHost";
import { msg, pluginText, t, translate } from "../../i18n";

function NoMap({ entry, title, icon }: { entry: DialogProps["entry"]; title: string; icon: React.ReactNode }) {
  return <DialogFrame dialogKey={entry.key} title={title} icon={icon} size="sm"><p className="hint">{t("Open or create a map first.")}</p></DialogFrame>;
}

/** A file name to suggest: the open file's stem, else the scenario name, made safe. */
function useFileStem(): string {
  const path = useAtomValue(mapFilePathAtom);
  const name = useAtomValue(mapNameAtom);
  const plain = [...(path ?? name).replace(/\.(scm|scx|chk)$/i, "")].filter((c) => c.charCodeAt(0) >= 0x20).join("");
  const stem = plain.replace(/[\\/:*?"<>|]/g, "_").trim();
  return stem || "scenario";
}

/** A picked file, via a hidden input (the picker API's type filter is fussier than a plain accept). */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

const encodeText = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0) & 0xff));

/* ── Triggers ────────────────────────────────────────────── */

type Target = "triggers" | "briefing";
const TARGETS: { value: Target; label: string }[] = [{ value: "triggers", label: msg("Triggers (TRIG)") }, { value: "briefing", label: msg("Mission briefing (MBRF)") }];
const FORMATS: { value: TriggerFileFormat; label: string }[] = [{ value: "txt", label: msg("Text (.txt, TrigEdit syntax)") }, { value: "trg", label: msg("Binary (.trg, raw records)") }];

export function ExportTriggersDialog({ entry }: DialogProps) {
  const scenario = useAtomValue(scenarioAtom);
  useAtomValue(triggersRevisionAtom);
  const setStatus = useSetAtom(statusMessageAtom);
  const toast = useSetAtom(pushToastAtom);
  const stem = useFileStem();
  const [format, setFormat] = useState<TriggerFileFormat>((entry.payload?.format as TriggerFileFormat) ?? "txt");
  const [target, setTarget] = useState<Target>("triggers");
  if (!scenario) return <NoMap entry={entry} title={t("Export Triggers")} icon={<Download size={14} />} />;

  const list = target === "triggers" ? scenario.triggers : scenario.briefing;
  const fileName = `${stem}${target === "briefing" ? "-briefing" : "-triggers"}.${format}`;
  const doExport = async () => {
    const bytes = format === "trg" ? encodeTrg(list) : encodeText(triggersToText(scenario, list, target === "briefing"));
    const out = await saveBytes(bytes, fileName);
    if (out) {
      const text = target === "briefing"
        ? t("Exported {n, plural, one {# briefing} other {# briefings}} to {fileName}", { n: list.length, fileName: out.fileName })
        : t("Exported {n, plural, one {# trigger} other {# triggers}} to {fileName}", { n: list.length, fileName: out.fileName });
      setStatus(text);
      toast({ kind: "ok", title: out.route === "download" ? t("Triggers downloaded") : t("Triggers exported"), detail: out.route === "download" ? t("{text} — in {downloads}.", { text, downloads: hostTerms().downloads }) : text });
    }
  };

  return (
    <DialogFrame dialogKey={entry.key} title={t("Export Triggers")} icon={<Download size={14} />} size="sm" okLabel={t("Export")} onOk={() => { void doExport(); }} footerLeft={<span className="mono hint">{fileName}</span>}>
      <Group title={t("What")}>
        <div className="form wide">
          <Field label={t("Export")}><Select value={target} onChange={(e) => setTarget(e.target.value as Target)} options={TARGETS} /></Field>
          <Field label={t("Format")}><Select value={format} onChange={(e) => setFormat(e.target.value as TriggerFileFormat)} options={FORMATS} /></Field>
        </div>
      </Group>
      <p className="hint">
        {format === "txt" ? t("Text triggers name units, locations and switches as this map does and carry their strings, so they can be read into another map. Unknown names print as numbers.") : t("A .trg is the section's own bytes (2400 per record), as SCMDraft exports them. It holds string indices, not text, so it only fits a copy of this map.")}
        {" "}{t("{n, plural, one {# record} other {# records}} to write.", { n: list.length })}
      </p>
    </DialogFrame>
  );
}

interface ImportState {
  fileName: string;
  triggers: TriggerRecord[] | null;
  error: string | null;
}

type Source = "file" | "paste";

/** Pasted text, parsed (with its strings as drafts) or the reason it does not parse. */
function usePasted(scenario: Scenario | null, text: string, briefing: boolean): { pasted: PastedTriggers | null; error: string | null } {
  // Locations, unit names and switch names can change under an open dialog (as `useNames`
  // in TriggerDialogs.tsx watches them).
  const rev = useAtomValue(triggersRevisionAtom);
  const settingsRev = useAtomValue(settingsRevisionAtom);
  const locationsRev = useAtomValue(locationsRevisionAtom);
  // Parsing a long list at every keystroke would make typing lag; React parses the last
  // text it has time for.
  const deferred = useDeferredValue(text);
  return useMemo(() => {
    if (!scenario || !deferred.trim()) return { pasted: null, error: null };
    try {
      return { pasted: parsePastedTriggers(scenario, deferred, briefing), error: null };
    } catch (err) {
      return { pasted: null, error: err instanceof Error ? err.message : String(err) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, deferred, briefing, rev, settingsRev, locationsRev]);
}

export function ImportTriggersDialog({ entry }: DialogProps) {
  const scenario = useAtomValue(scenarioAtom);
  const triggersRev = useAtomValue(triggersRevisionAtom);
  const claims = useAtomValue(pluginTriggerClaimsAtom);
  const commit = useSetAtom(commitTriggersAtom);
  const close = useSetAtom(closeDialogAtom);
  const setStatus = useSetAtom(statusMessageAtom);
  const toast = useSetAtom(pushToastAtom);
  const [target, setTarget] = useState<Target>("triggers");
  const [replace, setReplace] = useState(false);
  const [state, setState] = useState<ImportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<Source>(entry.payload?.source === "paste" ? "paste" : "file");
  const settingsRev = useAtomValue(settingsRevisionAtom);
  const locationsRev = useAtomValue(locationsRevisionAtom);
  // Before anything is pasted, the box shows the list as it is now, all of it, as text: what
  // a paste will replace, and a copy to edit and paste back.
  const current = useMemo(
    () => (scenario ? triggersToText(scenario, target === "briefing" ? scenario.briefing : scenario.triggers, target === "briefing") : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenario, target, triggersRev, settingsRev, locationsRev],
  );
  const [pasteText, setPasteText] = useState(current);
  const shown = useRef(current);
  useEffect(() => {
    // The list changed under the dialog (an undo, the List choice): follow it while the box
    // still holds the list it showed, and leave the user's own text alone.
    if (pasteText === shown.current) setPasteText(current);
    shown.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  const edited = pasteText !== current;
  const box = useRef<HTMLTextAreaElement>(null);
  // While the box shows the map's own list, focusing it selects all of it, so a Ctrl+V
  // straight away replaces the whole shown list with the pasted one. (DialogFrame focuses
  // the first text field when the dialog opens; a mouse click still places the caret.)
  const selectShown = (el: HTMLTextAreaElement) => {
    if (el.value !== current) return;
    el.select();
    el.scrollTop = 0;
  };
  useEffect(() => {
    const el = box.current;
    if (source !== "paste" || !el) return;
    if (document.activeElement === el) selectShown(el); else el.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const { pasted, error: pasteError } = usePasted(scenario, edited ? pasteText : "", target === "briefing");
  if (!scenario) return <NoMap entry={entry} title={t("Import Triggers")} icon={<Upload size={14} />} />;

  const accept = entry.payload?.format === "trg" ? ".trg" : entry.payload?.format === "txt" ? ".txt" : ".txt,.trg";
  const pick = async () => {
    const file = await pickFile(accept);
    if (!file) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const triggers = readTriggerFile(scenario, file.name, bytes, target === "briefing");
      setState({ fileName: file.name, triggers, error: null });
    } catch (err) {
      setState({ fileName: file.name, triggers: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    if (!state?.triggers) return;
    const existing = target === "triggers" ? scenario.triggers : scenario.briefing;
    const next = replace ? state.triggers : [...existing, ...state.triggers];
    if (target === "triggers") applyTriggers(scenario, next); else applyBriefing(scenario, next);
    commit();
    const n = state.triggers.length;
    const text = (target === "briefing" ? t("Imported {n, plural, one {# briefing} other {# briefings}} from {file}", { n, file: state.fileName }) : t("Imported {n, plural, one {# trigger} other {# triggers}} from {file}", { n, file: state.fileName })) + (replace ? t(" (replaced the list)") : "");
    setStatus(text);
    toast({ kind: "ok", title: t("Triggers imported"), detail: text });
    close(entry.key);
  };
  // Pasted text always replaces the whole list: what is in the box is the list wanted.
  const applyPasted = () => {
    if (!pasted) return;
    const briefing = target === "briefing";
    const before = replaceWithPasted(scenario, pasted, briefing);
    commit();
    const n = pasted.triggers.length;
    const text = briefing
      ? t("Replaced {before, plural, one {# briefing} other {# briefings}} with {n, plural, one {# pasted briefing} other {# pasted briefings}}", { before, n })
      : t("Replaced {before, plural, one {# trigger} other {# triggers}} with {n, plural, one {# pasted trigger} other {# pasted triggers}}", { before, n });
    setStatus(text);
    toast({ kind: "ok", title: t("Triggers replaced"), detail: text });
    close(entry.key);
  };
  const pasteFromClipboard = async () => {
    setClipboardError(null);
    try {
      setPasteText(await navigator.clipboard.readText());
    } catch {
      setClipboardError(t("The browser did not hand over the clipboard. Click in the box and press Ctrl+V instead."));
    }
  };
  const count = target === "triggers" ? scenario.triggers.length : scenario.briefing.length;
  const replacing = source === "paste" || replace;

  return (
    <DialogFrame dialogKey={entry.key} title={t("Import Triggers")} icon={<Upload size={14} />} size={source === "paste" ? "lg" : "sm"} footerLeft={<span className="hint">{t("{count} in the map now", { count })}</span>}
      footer={source === "paste"
        ? <><Button variant="primary" disabled={!pasted} onClick={applyPasted}>{t("Replace all")}</Button><CloseButton entry={entry} /></>
        : <><Button variant="primary" disabled={!state?.triggers} onClick={apply}>{t("Import")}</Button><CloseButton entry={entry} /></>}
    >
      <Group title={t("From")}>
        <div className="row" style={{ gap: 12 }}>
          <Check radio name="import-source" label={t("A file")} checked={source === "file"} onChange={() => setSource("file")} />
          <Check radio name="import-source" label={t("Pasted text")} checked={source === "paste"} onChange={() => setSource("paste")} />
        </div>
      </Group>
      {source === "file" ? (
        <Group title={t("File")}>
          <div className="row">
            <Button size="sm" onClick={() => { void pick(); }} disabled={busy}><Upload size={12} /> {" "}{t("Choose file…")}</Button>
            <span className={`hint ${state?.error ? "error-text" : ""}`} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {busy ? t("Reading…") : state ? state.error ? `${state.fileName}: ${state.error}` : t("{fileName}: {length, plural, one {# record} other {# records}}", { fileName: state.fileName, length: state.triggers!.length }) : t("A .txt in TrigEdit syntax or a .trg from SCMDraft ({accept}).", { accept })}
            </span>
          </div>
        </Group>
      ) : (
        <Group title={t("Text")}>
          <TextArea
            ref={box}
            className="mono"
            rows={18}
            spellCheck={false}
            wrap="off"
            value={pasteText}
            placeholder={t("Paste triggers here in TrigEdit syntax, as Export Triggers and the Text Trigger Editor write them: Trigger(\"Player 1\"){ … }")}
            onChange={(e) => setPasteText(e.target.value)}
            onFocus={(e) => selectShown(e.currentTarget)}
            onKeyDown={(e) => e.stopPropagation()}
            style={{ width: "100%", resize: "vertical" }}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <Button size="sm" onClick={() => { void pasteFromClipboard(); }}><ClipboardPaste size={12} /> {" "}{t("Paste from clipboard")}</Button>
            {edited && current && <Button size="sm" variant="ghost" onClick={() => setPasteText(current)}>{t("Back to the map's triggers")}</Button>}
            {pasteText && <Button size="sm" variant="ghost" onClick={() => setPasteText("")}>{t("Clear")}</Button>}
            <span className={`hint ${pasteError || clipboardError ? "error-text" : ""}`} style={{ minWidth: 0 }}>
              {clipboardError ?? pasteError ?? (pasted
                ? (target === "briefing" ? t("{n, plural, one {# briefing} other {# briefings}} ready", { n: pasted.triggers.length }) : t("{n, plural, one {# trigger} other {# triggers}} ready", { n: pasted.triggers.length }))
                : !edited && current
                  ? (target === "briefing"
                    ? t("The map's {count, plural, one {# briefing} other {# briefings}}, as text. Paste over it to replace them all.", { count })
                    : t("The map's {count, plural, one {# trigger} other {# triggers}}, as text. Paste over it to replace them all.", { count }))
                  : "")}
            </span>
          </div>
        </Group>
      )}
      <Group title={t("Into")}>
        <div className="form wide">
          <Field label={t("List")}><Select value={target} onChange={(e) => { setTarget(e.target.value as Target); setState(null); }} options={TARGETS} /></Field>
          {source === "file" ? (
            <Field label={t("Mode")}>
              <div className="col" style={{ gap: 2 }}>
                <Check radio name="import-mode" label={target === "briefing" ? t("Append after the existing briefings") : t("Append after the existing triggers")} checked={!replace} onChange={() => setReplace(false)} />
                <Check radio name="import-mode" label={t("Replace the whole list")} checked={replace} onChange={() => setReplace(true)} />
              </div>
            </Field>
          ) : (
            <Field label={t("Mode")}>
              <span className="hint">{target === "briefing"
                ? t("Pasted briefings replace all {count, plural, one {# briefing} other {# briefings}} in the map (one undo step).", { count })
                : t("Pasted triggers replace all {count, plural, one {# trigger} other {# triggers}} in the map (one undo step).", { count })}</span>
            </Field>
          )}
        </div>
        {replacing && target === "triggers" && locateClaims(claims, scenario.triggers).map((c) => <p key={c.claim.key} className="hint" style={{ marginTop: 6 }}>{t("Replacing removes the {count, plural, one {# trigger} other {# triggers}} generated by {label}; {pluginName} can build them again.", { count: c.count, label: pluginText(c.claim.pluginId, c.claim.spec.label), pluginName: c.claim.pluginName })}</p>)}
      </Group>
      <p className="hint">{t("Text names are resolved against this map's units, locations and switches; the first line that does not resolve is reported above. Strings in the text are added to the string table as needed.")}</p>
    </DialogFrame>
  );
}

function CloseButton({ entry }: { entry: DialogProps["entry"] }) {
  const close = useSetAtom(closeDialogAtom);
  return <Button onClick={() => close(entry.key)}>{t("Close")}</Button>;
}

/* ── Strings ─────────────────────────────────────────────── */

const STRING_FORMAT_HINT = msg("One line per string: the index, a tab, the text. \\n, \\t and \\\\ are escaped; other control characters (the colour codes) are written as <XX> in hex and a literal < as \\<. Lines starting with # are ignored.");

export function ExportStringsDialog({ entry }: DialogProps) {
  const scenario = useAtomValue(scenarioAtom);
  useAtomValue(settingsRevisionAtom);
  const setStatus = useSetAtom(statusMessageAtom);
  const toast = useSetAtom(pushToastAtom);
  const stem = useFileStem();
  if (!scenario) return <NoMap entry={entry} title={t("Export Strings")} icon={<FileText size={14} />} />;
  const fileName = `${stem}-strings.txt`;
  const count = scenario.strings.strings.filter((s, i) => i > 0 && s !== null).length;
  const doExport = async () => {
    const out = await saveBytes(encodeText(formatStringTable(scenario.strings)), fileName);
    if (out) {
      setStatus(t("Exported {count, plural, one {# string} other {# strings}} to {fileName}", { count, fileName: out.fileName }));
      toast({ kind: "ok", title: out.route === "download" ? t("Strings downloaded") : t("Strings exported"), detail: out.route === "download" ? t("{count, plural, one {# string} other {# strings}} — {fileName}, in {downloads}", { count, fileName: out.fileName, downloads: hostTerms().downloads }) : t("{count, plural, one {# string} other {# strings}} — {fileName}", { count, fileName: out.fileName }) });
    }
  };
  return (
    <DialogFrame dialogKey={entry.key} title={t("Export Strings")} icon={<Download size={14} />} size="sm" okLabel={t("Export")} onOk={() => { void doExport(); }} footerLeft={<span className="mono hint">{fileName}</span>}>
      <p>{t("{count, plural, one {# string} other {# strings}} of {v} slots are set.", { count, v: scenario.strings.strings.length - 1 })}</p>
      <p className="hint">{translate(STRING_FORMAT_HINT)}</p>
    </DialogFrame>
  );
}

interface StringImportState {
  fileName: string;
  entries: { index: number; text: string }[];
  errors: { line: number; message: string }[];
}

export function ImportStringsDialog({ entry }: DialogProps) {
  const scenario = useAtomValue(scenarioAtom);
  useAtomValue(settingsRevisionAtom);
  const commit = useSetAtom(commitSettingsAtom);
  const close = useSetAtom(closeDialogAtom);
  const setStatus = useSetAtom(statusMessageAtom);
  const toast = useSetAtom(pushToastAtom);
  const setName = useSetAtom(mapNameAtom);
  const setDescription = useSetAtom(mapDescriptionAtom);
  const [state, setState] = useState<StringImportState | null>(null);
  if (!scenario) return <NoMap entry={entry} title={t("Import Strings")} icon={<Upload size={14} />} />;

  const pick = async () => {
    const file = await pickFile(".txt");
    if (!file) return;
    const text = new TextDecoder("latin1").decode(new Uint8Array(await file.arrayBuffer()));
    setState({ fileName: file.name, ...parseStringTable(text) });
  };
  const apply = () => {
    if (!state) return;
    const { replaced, added } = applyStringImport(scenario, state.entries);
    if (replaced > 0 || added > 0) commit();
    // The chrome shows mirror atoms of the name and description; keep them in step with the table.
    const name = getString(scenario.strings, scenario.nameIndex);
    if (name !== null) setName(name);
    setDescription(getString(scenario.strings, scenario.descriptionIndex) ?? "");
    setStatus(t("Imported strings from {fileName}: {replaced} replaced, {added} added", { fileName: state.fileName, replaced, added }));
    toast({ kind: "ok", title: t("Strings imported"), detail: t("{fileName}: {replaced} replaced, {added} added", { fileName: state.fileName, replaced, added }) });
    close(entry.key);
  };
  const size = scenario.strings.strings.length;
  const replacing = state ? state.entries.filter((e) => e.index < size).length : 0;

  return (
    <DialogFrame dialogKey={entry.key} title={t("Import Strings")} icon={<Upload size={14} />} size="sm"
      footer={<><Button variant="primary" disabled={!state || state.entries.length === 0} onClick={apply}>{t("Import")}</Button><CloseButton entry={entry} /></>}
      footerLeft={<span className="hint">{t("{v} slots in the map now", { v: size - 1 })}</span>}
    >
      <Group title={t("File")}>
        <div className="row">
          <Button size="sm" onClick={() => { void pick(); }}><Upload size={12} /> {" "}{t("Choose file…")}</Button>
          <span className="hint" style={{ minWidth: 0 }}>
            {state ? t("{fileName}: {length, plural, one {# string} other {# strings}} — {replacing} replace existing slots, {v} append", { fileName: state.fileName, length: state.entries.length, replacing, v: state.entries.length - replacing }) : t("A .txt written by Export Strings.")}
          </span>
        </div>
        {state && state.errors.length > 0 && <p className="error-text" style={{ marginTop: 6 }}>{t("{n, plural, one {# line} other {# lines}} skipped — first: line {line}, {message}.", { n: state.errors.length, line: state.errors[0].line, message: state.errors[0].message })}</p>}
      </Group>
      <p className="hint">{t("Each string goes to the index on its line, so triggers and locations that use it pick up the new text; an index past the end of the table appends. Nothing is renumbered or removed.")}</p>
      <p className="hint">{translate(STRING_FORMAT_HINT)}</p>
    </DialogFrame>
  );
}
