import { readFileSync } from "node:fs";
import { mapFiles } from "./support/maps";
import { describe, expect, it } from "vitest";
import { createScenario } from "../src/formats/chk/create";
import { parseScenario } from "../src/formats/chk/scenario";
import { ActionFlag, ActionType, ConditionType, PlayerGroup, TRIGGER_STRIDE, type TriggerRecord } from "../src/formats/chk/sections/triggers";
import { getString } from "../src/formats/chk/sections/strings";
import { TriggerTextError } from "../src/formats/triggers/text";
import {
  applyStringImport, decodeTrg, encodeTrg, escapeStringText, formatStringTable, parsePastedTriggers, parseStringTable, readTriggerFile, replaceWithPasted, triggerFormatOf,
  triggersFromText, triggersToText, unescapeStringText,
} from "../src/editor/exchange";
import { internString } from "../src/editor/settings";
import { applyTriggers, newAction, newTrigger } from "../src/editor/triggers";
import { loadMap } from "../src/formats/mpq/scm";

function fresh() {
  return createScenario({ width: 64, height: 64, era: 4, name: "T", description: "d" });
}

function sample(scn = fresh()): { scn: ReturnType<typeof fresh>; triggers: TriggerRecord[] } {
  const t = newTrigger([PlayerGroup.Player1]);
  const text = newAction(ActionType.DisplayText);
  text.text = internString(scn, "Hello <04>world");
  text.flags |= ActionFlag.AlwaysDisplay;
  t.actions.push(text, newAction(ActionType.PreserveTrigger));
  const u = newTrigger([PlayerGroup.AllPlayers]);
  u.actions.push(newAction(ActionType.Victory));
  return { scn, triggers: [t, u] };
}

describe("trigger files", () => {
  it("writes a .trg as the raw records and reads it back", () => {
    const { triggers } = sample();
    const bytes = encodeTrg(triggers);
    expect(bytes.length).toBe(2 * TRIGGER_STRIDE);
    expect(decodeTrg(bytes)).toEqual(triggers);
    expect(() => decodeTrg(bytes.subarray(0, 100))).toThrow(/multiple of 2400/);
    expect(() => decodeTrg(new Uint8Array(0))).toThrow();
  });

  it("round-trips text through the map's names and reports a bad line", () => {
    const { scn, triggers } = sample();
    const text = triggersToText(scn, triggers);
    expect(text).toContain("Display Text Message");
    expect(text).toContain("Hello");
    const back = triggersFromText(scn, text);
    expect(back.length).toBe(2);
    expect(back[0].actions[0].type).toBe(ActionType.DisplayText);
    expect(getString(scn.strings, back[0].actions[0].text)).toBe("Hello <04>world");
    expect(back[1].actions[0].type).toBe(ActionType.Victory);
    let err: unknown = null;
    try { triggersFromText(scn, "Trigger(\"Player 1\"){\nConditions:\nActions:\n  Bogus Action(1);\n}"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TriggerTextError);
    expect((err as TriggerTextError).line).toBeGreaterThan(0);
  });

  it("picks the format by extension", () => {
    const { scn, triggers } = sample();
    expect(triggerFormatOf("a.TRG")).toBe("trg");
    expect(triggerFormatOf("a.txt")).toBe("txt");
    expect(triggerFormatOf("noext")).toBe("txt");
    expect(readTriggerFile(scn, "x.trg", encodeTrg(triggers))).toEqual(triggers);
    const bytes = new Uint8Array([...triggersToText(scn, triggers)].map((c) => c.charCodeAt(0)));
    expect(readTriggerFile(scn, "x.txt", bytes).length).toBe(2);
  });
});

describe("pasted triggers (Import Triggers ▸ Pasted text)", () => {
  const PASTE = 'Trigger("Player 2"){\nConditions:\n\tAlways();\nActions:\n\tDisplay Text Message(Always Display, "Pasted hello");\n}\n\nTrigger("All players"){\nConditions:\nActions:\n\tDefeat();\n}\n';
  const stringsIn = (scn: ReturnType<typeof fresh>) => scn.strings.strings.filter((s) => s !== null).length;

  it("parses as the box changes without adding a string to the map", () => {
    const { scn, triggers } = sample();
    applyTriggers(scn, triggers);
    const strings = stringsIn(scn);
    const pasted = parsePastedTriggers(scn, PASTE);
    expect(pasted.triggers.length).toBe(2);
    expect(pasted.triggers[0].actions[0].text).toBeLessThan(0);
    expect(stringsIn(scn)).toBe(strings);
    expect(scn.triggers.length).toBe(2);
  });

  it("replaces the whole list and interns only then", () => {
    const { scn, triggers } = sample();
    applyTriggers(scn, [...triggers, newTrigger([PlayerGroup.Player3])]);
    const before = replaceWithPasted(scn, parsePastedTriggers(scn, PASTE));
    expect(before).toBe(3);
    expect(scn.triggers.length).toBe(2);
    expect(scn.triggers[0].actions[0].type).toBe(ActionType.DisplayText);
    expect(getString(scn.strings, scn.triggers[0].actions[0].text)).toBe("Pasted hello");
    expect(scn.triggers[1].actions[0].type).toBe(ActionType.Defeat);
  });

  it("replaces the briefing list with briefings that start with Mission Briefing", () => {
    const scn = fresh();
    const before = replaceWithPasted(scn, parsePastedTriggers(scn, 'Trigger("All players"){\nConditions:\nActions:\n\tWait(1000);\n}\n', true), true);
    expect(before).toBe(0);
    expect(scn.briefing.length).toBe(1);
    expect(scn.briefing[0].conditions[0].type).toBe(ConditionType.Briefing);
    expect(scn.triggers.length).toBe(0);
  });

  it("shows the map's list as text that reads back as the same list", () => {
    // The box opens with triggersToText of the list; applied unedited, nothing would change.
    const { scn, triggers } = sample();
    applyTriggers(scn, triggers);
    const shown = triggersToText(scn, scn.triggers);
    expect(shown).toContain("Hello");
    const pasted = parsePastedTriggers(scn, shown);
    expect(pasted.drafts.byIndex.size).toBe(0);
    expect(pasted.triggers).toEqual(scn.triggers);
  });

  it("refuses text with no trigger, and reports the line of a bad one", () => {
    const scn = fresh();
    expect(() => parsePastedTriggers(scn, "just some words")).toThrow();
    expect(() => parsePastedTriggers(scn, "   \n")).toThrow(/no Trigger/);
    let err: unknown = null;
    try { parsePastedTriggers(scn, 'Trigger("Player 1"){\nConditions:\nActions:\n\tBogus Action(1);\n}'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TriggerTextError);
    expect((err as TriggerTextError).line).toBe(4);
  });
});

describe("string files", () => {
  it("escapes control bytes, tabs, newlines, backslashes and angle brackets both ways", () => {
    const raw = "a\x04b\\c\nd\te<f>\x1f";
    const escaped = escapeStringText(raw);
    expect(escaped).toBe("a<04>b\\\\c\\nd\\te\\<f><1F>");
    expect(unescapeStringText(escaped)).toBe(raw);
    expect(unescapeStringText("plain <zz> text")).toBe("plain <zz> text");
  });

  it("formats and parses the table, skipping comments and reporting bad lines", () => {
    const scn = fresh();
    scn.strings.strings.push("Line\ntwo", null, "\x03Coloured");
    const text = formatStringTable(scn.strings);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("1\tT");
    expect(lines).toContain("8\tLine\\ntwo");
    expect(lines).toContain("10\t<03>Coloured");
    expect(lines.some((l) => l.startsWith("9\t"))).toBe(false);
    const parsed = parseStringTable("# comment\n" + text + "\nno tab here\n0\tzero\n");
    expect(parsed.entries.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    expect(parsed.entries.find((e) => e.index === 10)!.text).toBe("\x03Coloured");
    expect(parsed.errors.map((e) => e.line)).toEqual([12, 13]);
  });

  it("imports in place, appends past the end and marks the string section dirty", () => {
    const scn = fresh();
    scn.dirty.clear();
    const before = scn.strings.strings.length;
    const r = applyStringImport(scn, [{ index: 1, text: "Renamed" }, { index: 2, text: "d" }, { index: before + 1, text: "gap" }, { index: before, text: "next" }]);
    expect(r).toEqual({ replaced: 1, added: 2 });
    expect(getString(scn.strings, 1)).toBe("Renamed");
    expect(getString(scn.strings, before)).toBe("next");
    expect(getString(scn.strings, before + 1)).toBe("gap");
    expect(scn.dirty.has("STR ")).toBe(true);
    const untouched = fresh();
    untouched.dirty.clear();
    expect(applyStringImport(untouched, [{ index: 1, text: "T" }])).toEqual({ replaced: 0, added: 0 });
    expect(untouched.dirty.size).toBe(0);
  });
});

describe("map files", () => {
  for (const { name: file, path } of mapFiles()) {
    it(`exports and re-imports the triggers and strings of ${file}`, async () => {
      const { chk } = await loadMap(new Uint8Array(readFileSync(path)));
      const scn = parseScenario(chk);
      const text = triggersToText(scn, scn.triggers);
      const back = triggersFromText(scn, text);
      expect(back.length).toBe(scn.triggers.length);
      if (scn.triggers.length > 0) expect(decodeTrg(encodeTrg(scn.triggers))).toEqual(scn.triggers);
      const strings = parseStringTable(formatStringTable(scn.strings));
      expect(strings.errors).toEqual([]);
      for (const { index, text: t } of strings.entries) expect(getString(scn.strings, index)).toBe(t);
    });
  }
});
