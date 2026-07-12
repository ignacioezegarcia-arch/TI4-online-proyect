// supabase/functions/_shared/ruleData.ts
//
// Builds the RuleData bundle GameEngine needs, straight from your existing
// data/*.json files (mirrored into ./data by scripts/sync-edge-functions.mjs
// — see that script for why they're copied here instead of imported from
// the repo root).
//
// TWO KNOWN GAPS, called out here so they can't be silently wrong:
//
// 1. Faction abilities (data/factions/<id>.json → factionAbilities[]) only
//    have `name` + `effect` today, no `id`. The engine's `AbilityId` /
//    `player.hasAbility(id)` convention needs a stable snake_case id per
//    ability (e.g. "orbital_drop", "versatile") to work at all. Until those
//    ids are added to the faction files, hasAbility() has nothing to match
//    against. Not blocking today's Edge Function work, but it's the very
//    next data task.
//
// 2. data/unitUpgrades.json's numeric stats (cost/combat/move/capacity) are
//    embedded in a free-text `effect` string ("Cost: 1(x2) | Combat: 7 | ...")
//    rather than structured fields, the way data/units.json already does it.
//    Parsing that string with a regex would be fragile and silently wrong
//    the day the wording changes. So: unit upgrades are loaded with their
//    id/unitType/prerequisites (useful for research eligibility later) but
//    WITHOUT resolved stats — getUnitStats() below falls back to the base
//    faction stats and logs a warning rather than guess. Fix: add the same
//    structured cost/combat/combatDiceCount/move/capacity/abilities fields
//    to unitUpgrades.json that units.json already uses.
import { RuleData, FactionUnitStats, UnitUpgradeStats } from "./engine/types/RuleData.ts";
import { FactionId, UnitUpgradeId, asFactionId } from "./engine/types/ids.ts";
import { UnitType } from "./engine/types/enums.ts";
import {
  unitEntryToStats,
  RawUnitEntry,
  buildPlanetsLookup,
  RawTilesFile,
  buildAgendasLookup,
  buildObjectivesLookup,
  buildTechnologiesLookup,
  buildUnitUpgradeTechDataLookup,
} from "./engine/rules/ruleDataMapping.ts";

interface RawFactionFile {
  id: string;
  commodities?: number;
  breakthrough?: { synergy?: { colors?: [string, string] } };
  units?: Record<string, Partial<RawUnitEntry> & { name?: string }>;
  // factionSpecificUnits intentionally not consumed yet (see gap #2 above
  // for the same reason — its `versions[]` entries use the same
  // schema, but wiring "which version is currently active" needs
  // researched-tech tracking on Player that isn't built yet either).
}

interface RawUnitUpgradeEntry {
  id: string;
  unitType: string;
  level: number;
  prerequisites: string[];
}

/**
 * Loads and shapes RuleData for exactly the factions in play — no reason to
 * parse every faction file on every request.
 */
export async function loadRuleData(factionIds: string[]): Promise<RuleData> {
  const unitsFile = JSON.parse(await Deno.readTextFile(new URL("./data/units.json", import.meta.url)));
  const baseUnitsById = new Map<string, RawUnitEntry>(unitsFile.units.map((u: RawUnitEntry) => [u.id, u]));

  const factionUnits: Record<FactionId, FactionUnitStats> = {};
  const factions: Record<FactionId, { commoditiesMax: number; breakthroughSynergy: [string, string] | null }> = {};

  for (const rawFactionId of factionIds) {
    const factionFile: RawFactionFile = JSON.parse(
      await Deno.readTextFile(new URL(`./data/factions/${rawFactionId}.json`, import.meta.url)),
    );
    const synergyColors = factionFile.breakthrough?.synergy?.colors;
    factions[asFactionId(rawFactionId)] = {
      commoditiesMax: factionFile.commodities ?? 0,
      breakthroughSynergy: synergyColors ? [synergyColors[0], synergyColors[1]] : null,
    };

    const baseUnits: Record<string, ReturnType<typeof unitEntryToStats> | undefined> = {};
    for (const [unitType, entry] of baseUnitsById) {
      baseUnits[unitType] = unitEntryToStats(entry, unitType as UnitType);
    }

    // Faction-sheet overrides for flagship/mech (units.json has no generic
    // entry for these — they're only ever faction-specific).
    for (const [unitType, override] of Object.entries(factionFile.units ?? {})) {
      baseUnits[unitType] = unitEntryToStats(override, unitType as UnitType);
    }

    factionUnits[asFactionId(rawFactionId)] = {
      factionId: asFactionId(rawFactionId),
      baseUnits: baseUnits as FactionUnitStats["baseUnits"],
    };
  }

  const unitUpgradesFile = JSON.parse(await Deno.readTextFile(new URL("./data/unitUpgrades.json", import.meta.url)));
  const unitUpgrades: Record<UnitUpgradeId, UnitUpgradeStats> = {};
  for (const raw of unitUpgradesFile.unitUpgrades as RawUnitUpgradeEntry[]) {
    // See gap #2: we deliberately do NOT populate `stats` with guessed
    // numbers. getUnitStats() in RuleData.ts checks for this and falls back
    // to the faction's base stats when `stats` is missing.
    console.warn(
      `unitUpgrades.json: "${raw.id}" has no structured stats yet (effect text isn't parsed) — falling back to base stats for ${raw.unitType} until the data is extended.`,
    );
  }

  const tilesFile = JSON.parse(await Deno.readTextFile(new URL("./data/tiles.json", import.meta.url)));
  const agendasFile = JSON.parse(await Deno.readTextFile(new URL("./data/agendas.json", import.meta.url)));
  const objectivesFile = JSON.parse(await Deno.readTextFile(new URL("./data/objectives.json", import.meta.url)));
  const technologiesFile = JSON.parse(await Deno.readTextFile(new URL("./data/technologies.json", import.meta.url)));
  const unitUpgradesFileRaw = JSON.parse(await Deno.readTextFile(new URL("./data/unitUpgrades.json", import.meta.url)));

  return {
    factionUnits,
    unitUpgrades,
    planets: buildPlanetsLookup(tilesFile as RawTilesFile),
    agendas: buildAgendasLookup(agendasFile as { agendas: { id: string; type: "law" | "directive" }[] }),
    objectives: buildObjectivesLookup(objectivesFile as Parameters<typeof buildObjectivesLookup>[0]),
    technologies: buildTechnologiesLookup(technologiesFile as Parameters<typeof buildTechnologiesLookup>[0]),
    factions,
    unitUpgradeTechData: buildUnitUpgradeTechDataLookup(
      (unitUpgradesFileRaw as { unitUpgrades: Parameters<typeof buildUnitUpgradeTechDataLookup>[0] }).unitUpgrades,
    ),
  };
}
