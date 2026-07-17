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
  // structured (not free-text) for a while — what was missing was
