// supabase/functions/_shared/ruleData.ts
//
// Builds the RuleData bundle GameEngine needs, straight from your existing
// data/*.json files (mirrored into ./data by scripts/sync-edge-functions.mjs
// — see that script for why they're copied here instead of imported from
// the repo root).
//
// Historical note: this file used to flag two data gaps here (faction
// ability ids missing snake_case ids; unitUpgrades.json's stats being
// free-text instead of structured). Both were fixed in the data a while
// ago — this comment is what's left after actually wiring the loader code
// up to read them, since the data being fixed doesn't help until the
// loader stops assuming it's still broken.
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
  buildFactionTechIds,
  buildExplorationCardsLookup,
  buildGenericPromissoryNotesLookup,
  buildFactionPromissoryNotesLookup,
  buildStartingDataLookup,
  buildActionCardIds,
  buildRelicIds,
  buildHomeSystemsLookup,
  buildFactionLeadersLookup,
} from "./engine/rules/ruleDataMapping.ts";

interface RawFactionFile {
  id: string;
  commodities?: number;
  breakthrough?: { synergy?: { colors?: [string, string] } };
  factionTechnologies?: { id: string }[];
  promissoryNote?: { name: string; versions: { version: string; source: string; timing: string; effect: string; placeInPlayArea: boolean }[] };
  promissoryNotes?: { name: string; versions: { version: string; source: string; timing: string; effect: string; placeInPlayArea: boolean }[] }[];
  startingUnits?: Record<string, number>;
  startingTechnologies?: string[];
  leaders?: {
    agent: { name: string; unlock: string; ability: string };
    commander: { name: string; unlock: string; ability: string };
    hero: { name: string; unlock: string; ability: string };
  };
  units?: Record<string, Partial<RawUnitEntry> & { name?: string }>;
  // factionSpecificUnits intentionally not consumed yet — its `versions[]`
  // entries use the same schema as units.json, but wiring "which version
  // is currently active" needs researched-tech tracking on Player that
  // isn't built yet either.
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
  const usedFactionFiles: RawFactionFile[] = [];

  for (const rawFactionId of factionIds) {
    const factionFile: RawFactionFile = JSON.parse(
      await Deno.readTextFile(new URL(`./data/factions/${rawFactionId}.json`, import.meta.url)),
    );
    usedFactionFiles.push(factionFile);
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

  // Gap #2 is now closed: data/unitUpgrades.json's stats have been
  // structured (not free-text) for a while — what was missing was this
  // loader actually reading them. Same unitEntryToStats() the base
  // units.json path already uses, since unitUpgrades.json entries match
  // the same RawUnitEntry shape plus a top-level `unitType` saying which
  // unit sheet this upgrade replaces (RR 86.4).
  const unitUpgrades: Record<UnitUpgradeId, UnitUpgradeStats> = {};
  for (const raw of unitUpgradesFile.unitUpgrades as (RawUnitEntry & { unitType: string })[]) {
    unitUpgrades[raw.id as UnitUpgradeId] = {
      id: raw.id as UnitUpgradeId,
      unitType: raw.unitType as UnitType,
      stats: unitEntryToStats(raw, raw.unitType as UnitType),
    };
  }

  const tilesFile = JSON.parse(await Deno.readTextFile(new URL("./data/tiles.json", import.meta.url)));
  const agendasFile = JSON.parse(await Deno.readTextFile(new URL("./data/agendas.json", import.meta.url)));
  const objectivesFile = JSON.parse(await Deno.readTextFile(new URL("./data/objectives.json", import.meta.url)));
  const technologiesFile = JSON.parse(await Deno.readTextFile(new URL("./data/technologies.json", import.meta.url)));
  const explorationCardsFile = JSON.parse(await Deno.readTextFile(new URL("./data/explorationCards.json", import.meta.url)));
  const promissoryNotesFile = JSON.parse(await Deno.readTextFile(new URL("./data/promissoryNotes.json", import.meta.url)));
  const actionCardsFile = JSON.parse(await Deno.readTextFile(new URL("./data/actionCards.json", import.meta.url)));
  const relicsFile = JSON.parse(await Deno.readTextFile(new URL("./data/relics.json", import.meta.url)));

  return {
    factionUnits,
    unitUpgrades,
    planets: buildPlanetsLookup(tilesFile as RawTilesFile),
    agendas: buildAgendasLookup(agendasFile as { agendas: { id: string; type: "law" | "directive" }[] }),
    objectives: buildObjectivesLookup(objectivesFile as Parameters<typeof buildObjectivesLookup>[0]),
    technologies: buildTechnologiesLookup(technologiesFile as Parameters<typeof buildTechnologiesLookup>[0]),
    factions,
    unitUpgradeTechData: buildUnitUpgradeTechDataLookup(
      (unitUpgradesFile as { unitUpgrades: Parameters<typeof buildUnitUpgradeTechDataLookup>[0] }).unitUpgrades,
    ),
    factionTechIds: buildFactionTechIds(usedFactionFiles),
    explorationCards: buildExplorationCardsLookup(explorationCardsFile as Parameters<typeof buildExplorationCardsLookup>[0]),
    genericPromissoryNoteTemplates: buildGenericPromissoryNotesLookup(
      promissoryNotesFile as Parameters<typeof buildGenericPromissoryNotesLookup>[0],
    ),
    factionPromissoryNotes: buildFactionPromissoryNotesLookup(usedFactionFiles),
    ...buildStartingDataLookup(usedFactionFiles),
    allActionCardIds: buildActionCardIds(actionCardsFile as Parameters<typeof buildActionCardIds>[0]),
    allRelicIds: buildRelicIds(relicsFile as Parameters<typeof buildRelicIds>[0]),
    ...buildHomeSystemsLookup(tilesFile as RawTilesFile),
    factionLeaders: buildFactionLeadersLookup(usedFactionFiles),
  };
      }
