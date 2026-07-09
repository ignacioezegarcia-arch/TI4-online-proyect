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
  abilities: { name: string; value?: number; diceCount?: number; text?: string }[];
}

export function unitEntryToStats(raw: Partial<RawUnitEntry>, unitType: UnitType): UnitStats {
  const rawAbilities = raw.abilities ?? [];
  const abilities = rawAbilities.map((a) => ABILITY_NAME_TO_ENUM[a.name]).filter((a): a is UnitAbility => Boolean(a));

  const abilityValues: Partial<Record<UnitAbility, { value: number; dice: number }>> = {};
  for (const a of rawAbilities) {
    const key = ABILITY_NAME_TO_ENUM[a.name];
    if (key && a.value !== undefined && a.diceCount !== undefined) {
      abilityValues[key] = { value: a.value, dice: a.diceCount };
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

export interface RawTilesFile {
  tiles: { planets?: { name: string; resources: number; influence: number }[] }[];
}

/** Shared by both loaders (browser + Edge Function) — builds the resources/influence lookup RuleData.planets needs, straight from data/tiles.json. */
export function buildPlanetsLookup(tilesFile: RawTilesFile): Record<string, { resources: number; influence: number }> {
  const planets: Record<string, { resources: number; influence: number }> = {};
  for (const tile of tilesFile.tiles) {
    for (const planet of tile.planets ?? []) {
      planets[planetNameToId(planet.name)] = { resources: planet.resources, influence: planet.influence };
    }
  }
  return planets;
}
