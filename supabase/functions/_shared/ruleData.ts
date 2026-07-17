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
} from "./engine/rules/ruleDataMapping.ts";

interface RawFactionFile {
  id: string;
  commodities?: number;
  breakthrough?: { synergy?: { colors?: [string, string] } };
  factionTechnologies?: { id: string }[];
  promissoryNote?: { name: string; versions: { version: string; source: string; timing: string; effect: string; placeInPlayArea: boolean }[] };
  promissoryNotes?: { name: string; versions: { version: string; source: string; timing: string; effect: string; placeInPlayArea: boolean }[] }[];
  units?: Record<string, Partial
