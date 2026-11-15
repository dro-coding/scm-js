/**
 * The Claude Agent plugin (github.com/dro-coding/plugin-claude-agent, which this fork
 * vendors into plugins/claude-agent at the version src/plugins/defaults.ts pins), its tools
 * run against a blank map through the editor's real plugin API: the same calls the agent
 * makes, without the model or the network. The plugin's own repository tests the rest (the
 * conversation loop, the tool set's shape, attachments, prices) with no editor; these are
 * the parts that need one. Needs `npm run vendor:plugins` first, like the other tests of
 * vendored plugins.
 */
import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { createScenario } from "../src/formats/chk/create";
import { scenarioAtom } from "../src/atoms/documentAtoms";
import { Contributions, createPluginApi } from "../src/plugins/host";
import type { PluginApi } from "../src/plugins/api";
import { validate } from "../plugins/claude-agent/src/schema";
import { TOOL_BY_NAME } from "../plugins/claude-agent/src/tools/index";
import { LABEL_PREFIX, ToolError, type ToolContext } from "../plugins/claude-agent/src/tools/types";
import { attachmentBlocks, type PickedFile } from "../plugins/claude-agent/src/attachments";
import { AgentSession } from "../plugins/claude-agent/src/session";
import { DEFAULTS } from "../plugins/claude-agent/src/settings";
import { encodeTriggers } from "../src/formats/chk/sections/triggers";

function setup(width = 64, height = 64): { api: PluginApi; call: (name: string, input?: Record<string, unknown>) => Promise<string> } {
  const store = createStore();
  store.set(scenarioAtom, createScenario({ width, height, era: 4, name: "Agent test" }));
  const api = createPluginApi(store, { id: "claude-agent", name: "Claude Agent", source: "github:dro-coding/plugin-claude-agent" }, new Contributions());
  const ctx: ToolContext = { api, label: (t) => `${LABEL_PREFIX}${t}`, touched: () => {}, signal: new AbortController().signal };
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const errors = validate(tool.schema, input);
    if (errors.length) throw new Error(`schema: ${errors.join("; ")}`);
    const out = await tool.run(input, ctx);
    return typeof out === "string" ? out : out.text;
  };
  return { api, call };
}

const parse = (s: string) => JSON.parse(s) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("agent tools on a map", () => {
  it("reads the overview", async () => {
    const { call } = setup();
    const o = parse(await call("map_overview"));
    expect(o).toMatchObject({ widthTiles: 64, heightTiles: 64, counts: { units: 0, triggers: 0 } });
    expect(o.players).toHaveLength(12);
  });

  it("places units with properties as one undo step under its own label, then changes, moves and deletes them", async () => {
    const { api, call } = setup();
    const placed = parse(await call("place_units", { units: [{ unitName: "Terran Marine", player: 1, tx: 10, ty: 10, count: 4, hitPoints: 50, invincible: true }], checkPlacement: false }));
    expect(placed.placed).toBe(4);
    expect(api.document.history().undo).toBe(`${LABEL_PREFIX}Place 4 unit(s)`);
    const listed = parse(await call("list_units", { player: 1 }));
    expect(listed.total).toBe(4);
    expect(listed.units[0]).toMatchObject({ name: "Terran Marine", player: 1, hitPoints: 50, states: ["invincible"] });
    // The block is centred on tile (10, 10).
    const xs = listed.units.map((u: { x: number }) => u.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBe(10 * 32 + 16);

    expect(parse(await call("update_units", { filter: { player: 1 }, set: { player: 2 } })).changed).toBe(4);
    expect(parse(await call("list_units", { player: 2 })).total).toBe(4);
    const before = api.document.scenario()!.units[0].x;
    await call("move_units", { filter: { player: 2 }, dtx: 2 });
    expect(api.document.scenario()!.units[0].x).toBe(before + 64);
    expect(parse(await call("delete_units", { filter: { name: "marine" } })).removed).toBe(4);
    expect(api.document.scenario()!.units).toHaveLength(0);
  });

  it("refuses a filter that names nothing rather than acting on every unit", async () => {
    const { call } = setup();
    await expect(call("delete_units", { filter: {} })).rejects.toBeInstanceOf(ToolError);
  });

  it("creates, edits and deletes locations by number, and says which triggers still use one", async () => {
    const { api, call } = setup();
    const made = parse(await call("create_location", { name: "Beacon", area: { x0: 4, y0: 4, x1: 8, y1: 6 }, excludeElevations: ["low air", "medium air", "high air"] }));
    expect(made).toMatchObject({ name: "Beacon", tiles: { x0: 4, y0: 4, x1: 8, y1: 6 }, pixels: { left: 128, top: 128, right: 256, bottom: 192 }, excludes: ["low air", "medium air", "high air"] });
    await call("edit_location", { number: made.number, name: "Gate" });
    expect(parse(await call("list_locations")).locations).toMatchObject([{ number: made.number, name: "Gate" }]);
    await call("add_triggers", { text: `Trigger("Player 1"){\nConditions:\n\tBring("Current Player", "Any unit", "Gate", At least, 1);\nActions:\n\tPreserve Trigger();\n}` });
    const del = parse(await call("delete_locations", { numbers: [made.number] }));
    expect(del).toMatchObject({ removed: 1, names: ["Gate"], stillUsedByTriggers: { [made.number]: [0] } });
    expect(api.query.locationsIn({ x0: 0, y0: 0, x1: 64, y1: 64 })).toEqual([]);
  });

  it("adds, reads, rewrites and deletes triggers as text", async () => {
    const { api, call } = setup();
    await call("create_location", { name: "Beacon", area: { x0: 1, y0: 1, x1: 3, y1: 3 } });
    const text = `Trigger("Player 1"){
Conditions:
	Bring("Current Player", "Terran Marine", "Beacon", At least, 1);
Actions:
	Display Text Message(Always Display, "You found the beacon.");
	Set Switch("Switch 1", set);
}

Trigger("All Players"){
Conditions:
	Always();
Actions:
	Preserve Trigger();
}`;
    expect(parse(await call("add_triggers", { text }))).toMatchObject({ added: 2, indices: [0, 1] });
    const listed = parse(await call("list_triggers"));
    expect(listed.total).toBe(2);
    expect(parse(await call("list_triggers", { runsFor: "Player 1" })).matched).toBe(1);
    const read = await call("read_triggers", { indices: [0] });
    expect(read).toContain("// #0");
    expect(read).toContain("\"Beacon\"");
    expect(read).toContain("\"You found the beacon.\"");

    // Inserted at the top, ahead of the two already there.
    await call("add_triggers", { at: 0, text: `Trigger("Player 2"){\nConditions:\n\tAlways();\nActions:\n\tVictory();\n}` });
    expect(api.triggers.summarize(api.triggers.list()[0]).actions).toMatch(/Victory/);

    await call("replace_triggers", { start: 0, count: 1, text: `Trigger("Player 2"){\nConditions:\n\tAlways();\nActions:\n\tDefeat();\n}` });
    expect(api.triggers.list()).toHaveLength(3);
    expect(api.triggers.summarize(api.triggers.list()[0]).actions).toMatch(/Defeat/);

    expect(parse(await call("delete_triggers", { indices: [0, 2] }))).toMatchObject({ removed: 2, remaining: 1 });
    expect(parse(await call("trigger_usage")).switches).toMatchObject([{ number: 1, mentions: 1 }]);
  });

  it("leaves the map exactly as it was when trigger text does not parse", async () => {
    const { api, call } = setup();
    const strings = api.query.strings().length;
    const depth = api.document.history().undoDepth;
    await expect(call("add_triggers", { text: `Trigger("Player 1"){\nConditions:\n\tAlways();\nActions:\n\tDisplay Text Message(Always Display, "A brand new string");\n\tNo Such Action(1);\n}` })).rejects.toThrow(/Line \d/);
    expect(api.triggers.list()).toHaveLength(0);
    expect(api.query.strings().length).toBe(strings);
    expect(api.document.history().undoDepth).toBe(depth);
    // A failed rewrite removes nothing.
    await call("add_triggers", { text: `Trigger("Player 1"){\nConditions:\n\tAlways();\nActions:\n\tVictory();\n}` });
    await expect(call("replace_triggers", { start: 0, count: 1, text: "Trigger(\"Player 1\"){ broken" })).rejects.toBeInstanceOf(ToolError);
    expect(api.triggers.list()).toHaveLength(1);
  });

  it("undoes only its own edits, stopping at the user's", async () => {
    const { api, call } = setup();
    api.document.edit("User's own edit", (tx) => { tx.placeUnit(0, 0, 100, 100); });
    await call("place_units", { units: [{ unitId: 0, player: 1, x: 300, y: 300 }], checkPlacement: false });
    await call("place_units", { units: [{ unitId: 0, player: 1, x: 400, y: 400 }], checkPlacement: false });
    const r = parse(await call("undo_my_edits", { count: 5 }));
    expect(r.undone).toHaveLength(2);
    expect(r.stopped).toMatch(/User's own edit/);
    expect(api.document.scenario()!.units).toHaveLength(1);
  });

  it("changes the scenario's properties, players, forces and unit settings", async () => {
    const { api, call } = setup();
    await call("set_map_properties", { name: "Agent Arena", description: "Made by the agent test." });
    expect(api.document.info()).toMatchObject({ name: "Agent Arena", description: "Made by the agent test." });
    await call("set_players", { players: [{ player: 2, type: "Computer", race: "Zerg", force: 2 }] });
    expect(api.settings.player(1)).toMatchObject({ typeName: "Computer", raceName: "Zerg", force: 1 });
    await call("set_forces", { forces: [{ force: 2, name: "The Swarm", allied: true }] });
    expect(api.settings.forces()[1]).toMatchObject({ name: "The Swarm", allied: true });
    await call("set_unit_settings", { units: [{ unitName: "Terran Marine", hitPoints: 80, name: "Veteran" }] });
    expect(api.settings.unitType(0)).toMatchObject({ hitPoints: 80, customName: "Veteran", useDefault: false });
    const rows = parse(await call("read_settings", { table: "units", modifiedOnly: true }));
    expect(rows.rows.map((r: { id: number }) => r.id)).toContain(0);
  });

  it("looks names up, and reads the editor's own documentation", async () => {
    const { call } = setup();
    const units = parse(await call("lookup", { what: "units", search: "zergling" }));
    expect(units.entries).toContainEqual({ value: 37, label: "Zerg Zergling" });
    const comparisons = parse(await call("lookup", { what: "comparisons" }));
    expect(comparisons.entries.map((e: { label: string }) => e.label)).toEqual(expect.arrayContaining(["At least", "At most", "Exactly"]));
    expect(await call("read_docs", { doc: "triggers" })).toContain("Conditions");
    const createUnit = await call("read_docs", { doc: "triggers", heading: "Create Unit" });
    expect(createUnit).toMatch(/^### Create Unit/);
    expect(createUnit).toContain("Create Unit(");
    expect(await call("trigger_signatures", { kind: "conditions", search: "bring" })).toMatch(/^Bring\(Player: player, Unit: unit, Location: location/);
  });

  it("says plainly when the tileset graphics are missing instead of guessing at terrain", async () => {
    const { call } = setup();
    await expect(call("terrain_map")).rejects.toThrow(/graphics are not installed/);
    await expect(call("paint_terrain", { terrain: "Dirt", area: { x0: 0, y0: 0, x1: 4, y1: 4 } })).rejects.toThrow(/graphics are not installed/);
  });
});

describe("attachments against the open map", () => {
  const file = (name: string, bytes: Uint8Array): PickedFile => ({ name, type: "", size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });

  it("prints a .trg as TrigEdit text through the editor's decoder, with a note on its strings", async () => {
    const { api, call } = setup();
    await call("add_triggers", { text: `Trigger("Player 1"){\nConditions:\n\tAlways();\nActions:\n\tVictory();\n}` });
    const session = new AgentSession(api, api.document.id(), () => DEFAULTS, () => {});
    const trg = await session.readFile(file("old.trg", encodeTriggers(api.triggers.list())));
    expect(trg.kind).toBe("text");
    expect(trg.data).toMatch(/Trigger\("Player 1"\)\{[\s\S]*Victory\(\);/);
    expect(trg.note).toMatch(/1 trigger\(s\) from a binary \.trg/);
    expect(attachmentBlocks([trg])[0]).toMatchObject({ type: "document", title: "old.trg", context: trg.note });
    await expect(session.readFile(file("bad.trg", new Uint8Array(100)))).rejects.toThrow(/not a trigger file/);
  });
});
