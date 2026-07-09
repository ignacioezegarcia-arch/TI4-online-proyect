// src/lib/loadRuleDataBrowser.ts
//
// Mirrors supabase/functions/_shared/ruleData.ts field-for-field (both call
// the same unitEntryToStats() from src/engine/rules/ruleDataMapping.ts) —
// this is what lets the client run GameEngine.applyAction() locally for
// instant optimistic UI updates, using the identical stats the Edge
// Function will use to authoritatively validate the same action a moment
// later.
import { RuleData, FactionUnitStats } from "../engine/types/RuleData";
import { FactionId, asFactionId } from "../engine/types/ids";
import { UnitType } from "../engine/types/enums";
import { unitEntryToStats, RawUnitEntry, buildPlanetsLookup, RawTilesFile } from "../engine/rules/ruleDataMapping";

import unitsFile from "../../data/units.json";
import tilesFile from "../../data/tiles.json";

// Vite-friendly way to "dynamically" import one of many known JSON files:
// eagerly globs all faction files at build time, keyed by their path, then
// this module picks the one it needs at runtime. Avoids fighting the
// bundler with a runtime-constructed import path.
const factionFiles = import.meta.glob("../../data/factions/*.json", { eager: true }) as Record<
  string,
  { default: { id: string; units?: Record<string, Partial<RawUnitEntry>> } }
>;

function findFactionFile(factionId: string) {
  const entry = Object.entries(factionFiles).find(([path]) => path.endsWith(`/${factionId}.json`));
  if (!entry) throw new Error(`No data/factions/${factionId}.json found.`);
  return entry[1].default;
}

export function loadRuleDataBrowser(factionIds: string[]): RuleData {
  const baseUnitsById = new Map<string, RawUnitEntry>(
    (unitsFile as { units: RawUnitEntry[] }).units.map((u) => [u.id, u]),
  );

  const factionUnits: Record<FactionId, FactionUnitStats> = {};

  for (const rawFactionId of factionIds) {
    const factionFile = findFactionFile(rawFactionId);

    const baseUnits: Record<string, ReturnType<typeof unitEntryToStats> | undefined> = {};
    for (const [unitType, entry] of baseUnitsById) {
      baseUnits[unitType] = unitEntryToStats(entry, unitType as UnitType);
    }
    for (const [unitType, override] of Object.entries(factionFile.units ?? {})) {
      baseUnits[unitType] = unitEntryToStats(override, unitType as UnitType);
    }

    factionUnits[asFactionId(rawFactionId)] = {
      factionId: asFactionId(rawFactionId),
      baseUnits: baseUnits as FactionUnitStats["baseUnits"],
    };
  }

  // See supabase/functions/_shared/ruleData.ts gap #2 — unit upgrades are
  // intentionally left unresolved client-side too, for the same reason.
  return { factionUnits, unitUpgrades: {}, planets: buildPlanetsLookup(tilesFile as RawTilesFile) };
}
