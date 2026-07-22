import { UnitStats } from "../types/RuleData";
import { UnitAbility, UnitType } from "../types/enums";

/**
 * Isomorphic on purpose: takes already-parsed JSON objects, does no file
 * reading of its own, so the exact same code runs in the browser (Vite JSON
 * import) and inside the Deno Edge Function (Deno.readTextFile + JSON.parse)
 * with zero duplication. If this mapping ever needs a fix, there is exactly
 * one file to touch.
 */
export const ABILITY_NAME_TO_ENUM: Record<string, UnitAbility> = {
  "Anti-Fighter Barrage": "antiFighterBarrage",
  Bombardment: "bombardment",
  "Planetary Shield": "planetaryShield",
  Production: "production",
  "Space Cannon": "spaceCannon",
  "Sustain Damage": "sustainDamage",
};

export interface RawUnitEntry {
  id: string;
  category: "ship" | "groundForce" | "structure";
  cost: number | string;
  producesQuantity?: number;
  combat: number | null;
  combatDiceCount?: number;
  move: number | null;
  capacity: number;
  /** Matches data/units.json's & unitUpgrades.json's actual shape: value/diceCount are present for abilities with a numeric effect (AFB, Bombardment, Space Cannon); absent for flat abilities (Sustain Damage, Planetary Shield, Production). NOTE: earlier version of this file assumed a free-text `effect` field that doesn't exist in the real data, silently dropping these numbers — see anomalies.ts-adjacent combat work for why this was caught now. */
  abilities: { name: string; value?: number; diceCount?: number; rangesToAdjacent?: boolean; text?: string }[];
}

export function unitEntryToStats(raw: Partial<RawUnitEntry>, unitType: UnitType): UnitStats {
  const rawAbilities = raw.abilities ?? [];
  const abilities = rawAbilities.map((a) => ABILITY_NAME_TO_ENUM[a.name]).filter((a): a is UnitAbility => Boolean(a));

  const abilityValues: Partial<Record<UnitAbility, { value: number; dice: number; rangesToAdjacent?: boolean }>> = {};
  for (const a of rawAbilities) {
    const key = ABILITY_NAME_TO_ENUM[a.name];
    if (key && a.value !== undefined && a.diceCount !== undefined) {
      abilityValues[key] = { value: a.value, dice: a.diceCount, rangesToAdjacent: a.rangesToAdjacent };
    }
  }

  return {
    unitType,
    cost: typeof raw.cost === "number" ? raw.cost : 0,
    combat: raw.combat ?? null,
    // Standard TI4 rule: every unit with a combat value rolls exactly 1 die
    // in normal combat unless the data says otherwise (no base/upgrade unit
    // currently overrides this, but faction/tech content down the line might).
    combatDiceCount: raw.combat != null ? (raw.combatDiceCount ?? 1) : undefined,
    move: raw.move ?? null,
    capacity: raw.capacity ?? null,
    producesQuantity: raw.producesQuantity ?? 1,
    abilities,
    abilityValues: Object.keys(abilityValues).length > 0 ? abilityValues : undefined,
  };
}

/**
 * data/factions/*.json's `units` field mixes two shapes for a given unit
 * type: a flat RawUnitEntry-compatible object (e.g. a faction's own
 * flagship/mech, which never has an upgrade path), OR a wrapper
 * `{ name, versions: [...] }` for a unit that DOES get upgraded via its own
 * unit-upgrade tech (e.g. Arborec's infantry, upgraded by Bioplasmosis).
 * This resolves EITHER shape down to "the level-1/base entry", which is
 * what factionUnits.baseUnits needs — level 2+ are handled separately by
 * buildFactionUnitUpgradesFromVersions below, since those are genuine unit
 * UPGRADES (RR 86), not part of the base faction sheet.
 */
export function resolveFactionUnitBaseEntry(
  override: Partial<RawUnitEntry> & { versions?: (Partial<RawUnitEntry> & { level: number })[] },
): Partial<RawUnitEntry> {
  if (!override.versions) return override;
  return override.versions.find((v) => v.level === 1) ?? override.versions[0];
}

/**
 * Synthesizes a proper RR 86 unit upgrade entry for every level-2-or-higher
 * `versions` entry across however many faction files are passed in (e.g.
 * Arborec's "Letani Warrior II", Argent Flight's "Strike Wing Alpha II") —
 * these were previously invisible to the engine entirely, since
 * factionFile.units[type] being a `{versions: [...]}` wrapper meant
 * unitEntryToStats() read an object with none of the fields it expects
 * (cost/combat/move/capacity/abilities all live one level deeper, inside
 * versions[n]), silently producing a broken all-null/zero stats block.
 *
 * Id is synthesized as `${factionId}_${unitType}_${level}` (e.g.
 * "arborec_infantry_2") since the raw data doesn't carry one of its own —
 * same reasoning as this file's other synthesized ids (faction leaders,
 * faction promissory notes). Every one of these is a genuine,
 * independently-researchable RR 90.7 unit upgrade — confirmed, the SAME
 * color-count prerequisite model as any generic unit upgrade, no
 * exceptions — so it's registered in unitUpgradeTechData exactly like the
 * generic ones are, and researched the same way (RESEARCH_UNIT_UPGRADE).
 *
 * Confirmed: since a faction-specific unit (e.g. Arborec's infantry) often
 * has no GENERIC upgrade slot to begin with (infantry has none in the base
 * tech tree at all), its own upgrade doubles as one of that faction's OWN
 * faction technologies — see buildFactionTechIds' own note on why these
 * ids get folded into that same set, not just factionTechnologies' own
 * entries.
 */
export function buildFactionUnitUpgradesFromVersions(
  factionFiles: {
    id: string;
    units?: Record<string, Partial<RawUnitEntry> & { versions?: (Partial<RawUnitEntry> & { level: number; color?: string; prerequisites?: string[] })[] }>;
  }[],
): {
  unitUpgrades: Record<string, { id: string; unitType: UnitType; stats: UnitStats }>;
  unitUpgradeTechData: Record<string, { color: string | null; prerequisites: string[] }>;
} {
  const unitUpgrades: ReturnType<typeof buildFactionUnitUpgradesFromVersions>["unitUpgrades"] = {};
  const unitUpgradeTechData: ReturnType<typeof buildFactionUnitUpgradesFromVersions>["unitUpgradeTechData"] = {};

  for (const file of factionFiles) {
    for (const [unitType, override] of Object.entries(file.units ?? {})) {
      if (!override.versions) continue;
      for (const version of override.versions) {
        if (version.level <= 1) continue; // level 1 is the base faction-sheet entry, handled elsewhere
        const upgradeId = `${file.id}_${unitType}_${version.level}`;
        unitUpgrades[upgradeId] = { id: upgradeId, unitType: unitType as UnitType, stats: unitEntryToStats(version, unitType as UnitType) };
        unitUpgradeTechData[upgradeId] = { color: version.color ?? null, prerequisites: version.prerequisites ?? [] };
      }
    }
  }

  return { unitUpgrades, unitUpgradeTechData };
}

/** data/tiles.json's planet name -> lowercase-underscore id, matching PlanetId's own convention (e.g. "Mecatol Rex" -> "mecatol_rex"). */
export function planetNameToId(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Shared by both loaders — the law/directive split RuleData.agendas needs, from data/agendas.json. Doesn't touch outcomes/effect text (see RuleData.ts's own scope note on this field). */
export function buildAgendasLookup(agendasFile: {
  agendas: { id: string; type: "law" | "directive"; removedByPoK?: boolean; elect?: string; isAttachment?: boolean; attachTechColor?: string }[];
}): Record<string, { type: "law" | "directive"; removedByPoK?: boolean; elect?: string; isAttachment?: boolean; attachTechColor?: string }> {
  const agendas: Record<string, { type: "law" | "directive"; removedByPoK?: boolean; elect?: string; isAttachment?: boolean; attachTechColor?: string }> = {};
  for (const a of agendasFile.agendas) {
    agendas[a.id] = { type: a.type, removedByPoK: a.removedByPoK, elect: a.elect, isAttachment: a.isAttachment, attachTechColor: a.attachTechColor };
  }
  return agendas;
}

/** Shared by both loaders — color + prerequisites (data/technologies.json), for "own N techs in M colors" objective checks and RR 90.7 prerequisite validation. */
export function buildTechnologiesLookup(technologiesFile: {
  generic: { id: string; color: string | null; prerequisites?: string[] }[];
}): Record<string, { color: string | null; prerequisites: string[] }> {
  const technologies: Record<string, { color: string | null; prerequisites: string[] }> = {};
  for (const t of technologiesFile.generic) {
    technologies[t.id] = { color: t.color, prerequisites: t.prerequisites ?? [] };
  }
  return technologies;
}

/**
 * Aggregates every faction's own factionTechnologies (data/factions/*.json)
 * across however many faction files are passed in, into the SAME shape as
 * buildTechnologiesLookup's own generic-tech output — a faction tech (e.g.
 * Argent Flight's Aerie Hololattice, Arborec's Bioplasmosis) has a real
 * color and its own RR 90.7 color-count prerequisites exactly like a
 * generic tech does, so it belongs in the SAME `rules.technologies` map
 * (merged in at the loader level), not a separate lookup — without this,
 * RESEARCH_TECHNOLOGY has no rule data to validate a faction tech's
 * prerequisites against, and once owned, its color is invisible to
 * color-based objective checks (checkPrerequisitesAgainst /
 * getOwnedTechColors both key off `rules.technologies[id]?.color`).
 */
export function buildFactionTechnologyDataLookup(
  factionFiles: { factionTechnologies?: { id: string; color: string | null; prerequisites?: string[] }[] }[],
): Record<string, { color: string | null; prerequisites: string[] }> {
  const technologies: Record<string, { color: string | null; prerequisites: string[] }> = {};
  for (const file of factionFiles) {
    for (const t of file.factionTechnologies ?? []) {
      technologies[t.id] = { color: t.color, prerequisites: t.prerequisites ?? [] };
    }
  }
  return technologies;
}

/** Shared by both loaders — color + prerequisites for unit upgrade techs (data/unitUpgrades.json), for RR 90.7 prerequisite validation. Separate from the full unitEntryToStats mapping (that's for combat stats once owned; this is just enough to check "can this player research it yet"). */
export function buildUnitUpgradeTechDataLookup(unitUpgradesFile: {
  id: string;
  color?: string | null;
  prerequisites?: string[];
}[]): Record<string, { color: string | null; prerequisites: string[] }> {
  const out: Record<string, { color: string | null; prerequisites: string[] }> = {};
  for (const u of unitUpgradesFile) {
    out[u.id] = { color: u.color ?? null, prerequisites: u.prerequisites ?? [] };
  }
  return out;
}

/** Aggregates every faction's factionTechnologies ids across however many faction files are passed in — for "own N faction techs" objective checks (Player.technologies doesn't distinguish faction vs. generic techs). Confirmed: a faction-specific unit's own upgrade (e.g. Arborec's Letani Warrior II, synthesized by buildFactionUnitUpgradesFromVersions) ALSO counts as one of that faction's technologies — that merge happens at the loader level (loadRuleDataBrowser.ts / supabase's ruleData.ts), right after both functions run, rather than duplicating the versions-iteration here. */
export function buildFactionTechIds(factionFiles: { factionTechnologies?: { id: string }[] }[]): Set<string> {
  const ids = new Set<string>();
  for (const file of factionFiles) {
    for (const tech of file.factionTechnologies ?? []) ids.add(tech.id);
  }
  return ids;
}

/** Shared by both loaders — RR 35 exploration card mechanics (data/explorationCards.json), keyed by card id across all 4 decks. */
export function buildExplorationCardsLookup(explorationCardsFile: {
  decks: Record<
    "cultural" | "industrial" | "hazardous" | "frontier",
    {
      cards: {
        id: string;
        attach?: boolean;
        isRelicFragment?: boolean;
        fragmentType?: "cultural" | "industrial" | "hazardous" | "any";
        keepInPlayArea?: boolean;
        resourceBonus?: number;
        influenceBonus?: number;
        techSpecialtyBonus?: string;
        fallbackResourceBonus?: number;
        fallbackInfluenceBonus?: number;
      }[];
    }
  >;
}) {
  const out: Record<
    string,
    {
      deck: "cultural" | "industrial" | "hazardous" | "frontier";
      isRelicFragment: boolean;
      fragmentType?: "cultural" | "industrial" | "hazardous" | "any";
      attach: boolean;
      keepInPlayArea: boolean;
      resourceBonus?: number;
      influenceBonus?: number;
      techSpecialtyBonus?: string;
      fallbackResourceBonus?: number;
      fallbackInfluenceBonus?: number;
    }
  > = {};
  for (const [deckName, deck] of Object.entries(explorationCardsFile.decks)) {
    for (const c of deck.cards) {
      out[c.id] = {
        deck: deckName as "cultural" | "industrial" | "hazardous" | "frontier",
        isRelicFragment: c.isRelicFragment ?? false,
        fragmentType: c.fragmentType,
        attach: c.attach ?? false,
        keepInPlayArea: c.keepInPlayArea ?? false,
        resourceBonus: c.resourceBonus,
        influenceBonus: c.influenceBonus,
        techSpecialtyBonus: c.techSpecialtyBonus,
        fallbackResourceBonus: c.fallbackResourceBonus,
        fallbackInfluenceBonus: c.fallbackInfluenceBonus,
      };
    }
  }
  return out;
}

/** Shared by both loaders — the 5 GENERIC promissory note templates (data/promissoryNotes.json), keyed by template id. Effect/timing text still has the literal "(color)" placeholder — see RuleData.ts's own note on why that's resolved later, at game setup, not here. */
export function buildGenericPromissoryNotesLookup(promissoryNotesFile: {
  generic: { id: string; name: string; timing: string; effect: string; placeInPlayArea: boolean; set: "base" | "pok" }[];
}): Record<string, { name: string; timing: string; effect: string; placeInPlayArea: boolean; set: "base" | "pok" }> {
  const out: ReturnType<typeof buildGenericPromissoryNotesLookup> = {};
  for (const n of promissoryNotesFile.generic) {
    out[n.id] = { name: n.name, timing: n.timing, effect: n.effect, placeInPlayArea: n.placeInPlayArea, set: n.set };
  }
  return out;
}

/** Aggregates each faction's own promissory note(s) (data/factions/*.json's promissoryNote field) across however many faction files are passed in. Only the "original" (base, non-codex-variant) version is used — same simplification as elsewhere in this project, no codex-version-in-play tracking exists yet. Synthesizes a stable id (`${factionId}_promissory`, or `_1`/`_2` for the rare multi-note faction) since the raw data doesn't carry one. */
export function buildFactionPromissoryNotesLookup(
  factionFiles: {
    id: string;
    promissoryNote?: { name: string; versions: { version: string; source: string; timing: string; effect: string; placeInPlayArea: boolean }[] };
    promissoryNotes?: { name: string; versions: { version: string; source: string; timing: string; effect: string; placeInPlayArea: boolean }[] }[];
  }[],
): Record<string, { id: string; name: string; timing: string; effect: string; placeInPlayArea: boolean }[]> {
  const out: ReturnType<typeof buildFactionPromissoryNotesLookup> = {};
  for (const file of factionFiles) {
    // Almost every faction has exactly one (promissoryNote); Empyrean-style
    // factions with two use promissoryNotes (plural) instead — support both
    // shapes rather than assuming everyone fits the common case.
    const notes = file.promissoryNotes ?? (file.promissoryNote ? [file.promissoryNote] : []);
    out[file.id] = notes.map((note, i) => {
      const original = note.versions.find((v) => v.source === "base") ?? note.versions[0];
      return {
        id: notes.length > 1 ? `${file.id}_promissory_${i + 1}` : `${file.id}_promissory`,
        name: note.name,
        timing: original.timing,
        effect: original.effect,
        placeInPlayArea: original.placeInPlayArea,
      };
    });
  }
  return out;
}

/** Aggregates each faction's starting units + starting technologies (data/factions/*.json) across however many faction files are passed in — RR "Gather Starting Components" needs both together, always for the same set of factions, so one function builds both maps in one pass rather than two near-identical loops. */
export function buildStartingDataLookup(
  factionFiles: { id: string; startingUnits?: Record<string, number>; startingTechnologies?: string[]; startingTechnologyChoice?: { count: number; options: string[] } }[],
): {
  startingUnits: Record<string, Record<string, number>>;
  startingTechnologies: Record<string, string[]>;
  startingTechnologyChoices: Record<string, { count: number; options: string[] } | undefined>;
} {
  const startingUnits: Record<string, Record<string, number>> = {};
  const startingTechnologies: Record<string, string[]> = {};
  const startingTechnologyChoices: Record<string, { count: number; options: string[] } | undefined> = {};
  for (const file of factionFiles) {
    startingUnits[file.id] = file.startingUnits ?? {};
    startingTechnologies[file.id] = file.startingTechnologies ?? [];
    startingTechnologyChoices[file.id] = file.startingTechnologyChoice;
  }
  return { startingUnits, startingTechnologies, startingTechnologyChoices };
}

/** Shared by both loaders — RR PoK "Leaders": each faction's agent(s)/commander/hero (data/factions/*.json's leaders field), synthesizing a stable id for each since the raw data doesn't carry one. Normalizes the raw data's own two shapes for the agent slot — a single `agent` object (nearly every faction) or a plural `agents` array (confirmed: only the Nomad, whose own "The Company" faction ability grants 2 extra) — into the SAME `agents: [...]` array shape either way, so callers never have to branch on which faction they're looking at. */
export function buildFactionLeadersLookup(
  factionFiles: {
    id: string;
    leaders?: {
      agent?: { name: string; unlock: string; ability: string };
      agents?: { name: string; unlock: string; ability: string }[];
      commander: { name: string; unlock: string; ability: string };
      hero: { name: string; unlock: string; ability: string };
    };
  }[],
): Record<
  string,
  {
    agents: { id: string; name: string; unlock: string; ability: string }[];
    commander: { id: string; name: string; unlock: string; ability: string };
    hero: { id: string; name: string; unlock: string; ability: string };
  }
> {
  const out: ReturnType<typeof buildFactionLeadersLookup> = {};
  for (const file of factionFiles) {
    if (!file.leaders) continue;
    const rawAgents = file.leaders.agents ?? (file.leaders.agent ? [file.leaders.agent] : []);
    out[file.id] = {
      agents: rawAgents.map((a, i) => ({ id: rawAgents.length > 1 ? `${file.id}_agent_${i + 1}` : `${file.id}_agent`, ...a })),
      commander: { id: `${file.id}_commander`, ...file.leaders.commander },
      hero: { id: `${file.id}_hero`, ...file.leaders.hero },
    };
  }
  return out;
}

export interface RawTilesFile {
  tiles: {
    id: number;
    homeFaction?: string;
    planets?: {
      name: string;
      resources: number;
      influence: number;
      traits?: string[];
      tech?: string[];
      isLegendary?: boolean;
      isMecatolRex?: boolean;
      isMallice?: boolean;
    }[];
  }[];
}

/** Shared by both loaders — which SystemId (tile id, as a string) is each faction's home system, straight from data/tiles.json's tile-level homeFaction field, plus which one is Mecatol Rex and which one (if any, PoK-only) is the off-map Wormhole Nexus. Needed at setup to know where to place a player's starting units/planets, and where the custodians token / Nexus goes, before any board has even been generated yet. */
export function buildHomeSystemsLookup(
  tilesFile: RawTilesFile,
): { homeSystemByFaction: Record<string, string>; mecatolSystemId: string; wormholeNexusSystemId: string | null } {
  const homeSystemByFaction: Record<string, string> = {};
  let mecatolSystemId = "";
  let wormholeNexusSystemId: string | null = null;
  for (const tile of tilesFile.tiles) {
    if (tile.homeFaction) homeSystemByFaction[tile.homeFaction] = String(tile.id);
    if (tile.planets?.some((p) => p.isMecatolRex)) mecatolSystemId = String(tile.id);
    if (tile.planets?.some((p) => p.isMallice)) wormholeNexusSystemId = String(tile.id);
  }
  return { homeSystemByFaction, mecatolSystemId, wormholeNexusSystemId };
}

/** Shared by both loaders (browser + Edge Function) — builds the per-planet static data RuleData.planets needs, straight from data/tiles.json. */
export function buildPlanetsLookup(tilesFile: RawTilesFile): Record<
  string,
  { resources: number; influence: number; traits: string[]; techSpecialties: string[]; isLegendary: boolean; isMecatolRex: boolean; isMallice: boolean; homeFactionId: import("../types/ids").FactionId | null }
> {
  const planets: ReturnType<typeof buildPlanetsLookup> = {};
  for (const tile of tilesFile.tiles) {
    for (const planet of tile.planets ?? []) {
      planets[planetNameToId(planet.name)] = {
        resources: planet.resources,
        influence: planet.influence,
        traits: planet.traits ?? [],
        techSpecialties: planet.tech ?? [],
        isLegendary: planet.isLegendary ?? false,
        isMecatolRex: planet.isMecatolRex ?? false,
        isMallice: planet.isMallice ?? false,
        homeFactionId: (tile.homeFaction ?? null) as import("../types/ids").FactionId | null,
      };
    }
  }
  return planets;
}

/** Shared by both loaders — the points + checkType/checkParams/timing/kind RuleData.objectives needs, from data/objectives.json's publicObjectives (stageI/stageII) and secretObjectives (all 3 phases). */
export function buildObjectivesLookup(objectivesFile: {
  publicObjectives: Record<"stageI" | "stageII", { id: string; points: number; checkType: string; checkParams: Record<string, unknown>; timing?: string }[]>;
  secretObjectives: Record<
    "actionPhase" | "statusPhase" | "agendaPhase",
    { id: string; points: number; checkType: string; checkParams: Record<string, unknown> }[]
  >;
}): Record<
  string,
  { points: number; checkType: string; checkParams: Record<string, unknown>; timing: "actionPhase" | "statusPhase" | "agendaPhase"; kind: "publicI" | "publicII" | "secret" }
> {
  const objectives: ReturnType<typeof buildObjectivesLookup> = {};
  for (const [stage, list] of Object.entries(objectivesFile.publicObjectives)) {
    for (const o of list) {
      objectives[o.id] = {
        points: o.points,
        checkType: o.checkType,
        checkParams: o.checkParams,
        timing: "statusPhase",
        kind: stage === "stageI" ? "publicI" : "publicII",
      };
    }
  }
  for (const [timing, list] of Object.entries(objectivesFile.secretObjectives)) {
    for (const o of list) {
      objectives[o.id] = {
        points: o.points,
        checkType: o.checkType,
        checkParams: o.checkParams,
        timing: timing as "actionPhase" | "statusPhase" | "agendaPhase",
        kind: "secret",
      };
    }
  }
  return objectives;
}

/** Shared by both loaders — every action card id (data/actionCards.json), for setup deck-seeding only (see RuleData.ts's own note on allActionCardIds). */
export function buildActionCardIds(actionCardsFile: { actionCards: { id: string }[] }): string[] {
  return actionCardsFile.actionCards.map((c) => c.id);
}

/** Shared by both loaders — every relic id (data/relics.json), for setup deck-seeding only (see RuleData.ts's own note on allRelicIds). */
export function buildRelicIds(relicsFile: { relics: { id: string }[] }): string[] {
  return relicsFile.relics.map((r) => r.id);
}
