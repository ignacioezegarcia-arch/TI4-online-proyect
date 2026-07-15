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
  /** Matches data/units.json's & unitUpgrades.json's actual shape: value/diceCount are present for abilities with a numeric effect (AFB, Bombardment, Space Cannon); absent for flat abilities (Sustain Damage, Planetary Shield, Production). */
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

/** data/tiles.json's planet name -> lowercase-underscore id, matching PlanetId's own convention (e.g. "Mecatol Rex" -> "mecatol_rex"). */
export function planetNameToId(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Shared by both loaders — the law/directive split RuleData.agendas needs, from data/agendas.json. Doesn't touch outcomes/effect text (see RuleData.ts's own scope note on this field). */
export function buildAgendasLookup(agendasFile: {
  agendas: { id: string; type: "law" | "directive" }[];
}): Record<string, { type: "law" | "directive" }> {
  const agendas: Record<string, { type: "law" | "directive" }> = {};
  for (const a of agendasFile.agendas) {
    agendas[a.id] = { type: a.type };
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

/** Aggregates every faction's factionTechnologies ids across however many faction files are passed in — for "own N faction techs" objective checks (Player.technologies doesn't distinguish faction vs. generic). */
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

export interface RawTilesFile {
  tiles: {
    homeFaction?: string;
    planets?: {
      name: string;
      resources: number;
      influence: number;
      traits?: string[];
      tech?: string[];
      isLegendary?: boolean;
      isMecatolRex?: boolean;
    }[];
  }[];
}

/** Shared by both loaders (browser + Edge Function) — builds the per-planet static data RuleData.planets needs, straight from data/tiles.json. */
export function buildPlanetsLookup(tilesFile: RawTilesFile): Record<
  string,
  { resources: number; influence: number; traits: string[]; techSpecialties: string[]; isLegendary: boolean; isMecatolRex: boolean; homeFactionId: import("../types/ids").FactionId | null }
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
        homeFactionId: (tile.homeFaction ?? null) as import("../types/ids").FactionId | null,
      };
    }
  }
  return planets;
}

/** Shared by both loaders — the points + checkType/checkParams/timing RuleData.objectives needs, from data/objectives.json's publicObjectives (stageI/stageII) and secretObjectives (all 3 phases). */
export function buildObjectivesLookup(objectivesFile: {
  publicObjectives: Record<string, { id: string; points: number; checkType: string; checkParams: Record<string, unknown>; timing?: string }[]>;
  secretObjectives: Record<
    "actionPhase" | "statusPhase" | "agendaPhase",
    { id: string; points: number; checkType: string; checkParams: Record<string, unknown> }[]
  >;
}): Record<string, { points: number; checkType: string; checkParams: Record<string, unknown>; timing: "actionPhase" | "statusPhase" | "agendaPhase" }> {
  const objectives: ReturnType<typeof buildObjectivesLookup> = {};
  for (const list of Object.values(objectivesFile.publicObjectives)) {
    for (const o of list) {
      objectives[o.id] = { points: o.points, checkType: o.checkType, checkParams: o.checkParams, timing: "statusPhase" };
    }
  }
  for (const [timing, list] of Object.entries(objectivesFile.secretObjectives)) {
    for (const o of list) {
      objectives[o.id] = {
        points: o.points,
        checkType: o.checkType,
        checkParams: o.checkParams,
        timing: timing as "actionPhase" | "statusPhase" | "agendaPhase",
      };
    }
  }
  return objectives;
}
