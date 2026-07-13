import { FactionId, AgendaId, ObjectiveId, PlanetId, TechId, UnitUpgradeId } from "./ids";
import { UnitAbility, UnitType } from "./enums";

/**
 * Static, game-content data the engine's pure functions read but never
 * mutate. GameState answers "what is currently true"; RuleData answers
 * "what are the rules of a cruiser" — it's effectively your existing
 * data/units.json + unitUpgrades.json + factions/*.json + technologies.json,
 * loaded once and passed into every GameEngine call. Keeping it separate
 * from GameState means the (much bigger) content JSON never has to be
 * diffed/re-sent over Supabase Realtime — only GameState changes per action.
 *
 * NOTE: shape below is a minimal slice covering what phases/tacticalAction.ts
 * needs today (move values, for RR 49.3). Extend as each new phase handler
 * needs more (combat values for space/ground combat, production values,
 * capacity, ability ids, prerequisites for research, etc.) rather than
 * front-loading the whole schema now — data/units.json etc. already has
 * the full content, this is just the typed read-path into it.
 */
export interface UnitStats {
  unitType: UnitType;
  cost: number;
  combat: number | null; // null for structures with no combat value (e.g. space dock)
  /** How many dice this unit rolls in *normal* combat (space or ground — both use this same stat). Undefined/1 when `combat` is set and the unit doesn't say otherwise; irrelevant when combat is null. Distinct from abilityValues' AFB/Bombardment/Space Cannon dice counts, which are separate sub-mechanics with their own dice pools. */
  combatDiceCount?: number;
  move: number | null;
  capacity: number | null;
  /** RR 58: how many units one "produce" action yields for `cost` (e.g. Fighter/Infantry = 2 per token). Defaults to 1 when the data doesn't say otherwise. */
  producesQuantity?: number;
  abilities: UnitAbility[];
  /** e.g. Anti-Fighter Barrage X(Y) -> {value: X, dice: Y}; Bombardment 5 -> {value:5, dice:1}. Keyed by ability for units with more than one. */
  abilityValues?: Partial<Record<UnitAbility, { value: number; dice: number }>>;
}

export interface FactionUnitStats {
  factionId: FactionId;
  /** Base stats per unit type from the faction sheet, before any researched unit upgrade is applied. */
  baseUnits: Record<UnitType, UnitStats | undefined>;
}

export interface UnitUpgradeStats {
  id: UnitUpgradeId;
  unitType: UnitType; // which faction-sheet unit this overrides (RR 86.1/86.4)
  stats: UnitStats;
}

export interface PlanetStaticData {
  resources: number;
  influence: number;
  traits: string[];
  techSpecialties: string[];
  isLegendary: boolean;
  isMecatolRex: boolean;
  /** Which faction's home system this planet sits in, if any (data/tiles.json's tile-level homeFaction). */
  homeFactionId: FactionId | null;
}

export interface ObjectiveStaticData {
  points: number;
  /** "manual" = not validated by the engine yet, caller/player is trusted — see data/objectives.json's own note on why (event-history-dependent or too bespoke to be worth a one-off checkType). */
  checkType: string;
  checkParams: Record<string, unknown>;
  /** RR 52.3: when this objective can legally be scored — most secrets are "statusPhase" like public objectives, but several score opportunistically during "actionPhase" or "agendaPhase" instead. */
  timing: "actionPhase" | "statusPhase" | "agendaPhase";
}

export interface RuleData {
  factionUnits: Record<FactionId, FactionUnitStats>;
  unitUpgrades: Record<UnitUpgradeId, UnitUpgradeStats>;
  /** Static resources/influence per planet (data/tiles.json), keyed by the same lowercase-underscore id as PlanetId (e.g. "jord", "mecatol_rex"). */
  planets: Record<PlanetId, PlanetStaticData>;
  /** RR 7: only the law-vs-directive split (data/agendas.json) — NOT the outcome/effect text, same "mechanics only" scope cut as objectives (see data/objectives.json's own note). Needed just to know whether a resolved agenda becomes a permanent law or gets discarded after one use. */
  agendas: Record<AgendaId, { type: "law" | "directive" }>;
  /** RR 52: points + how to validate the condition (data/objectives.json's checkType/checkParams). Most public objectives have a real checkType; most secrets are "manual" for now — see that file's own note. */
  objectives: Record<ObjectiveId, ObjectiveStaticData>;
  /** RR 90: only the color + prerequisites (data/technologies.json) — not the effect text. Prerequisites is a list of colors, one entry per required tech of that color (e.g. ["red","red"] = need 2 red techs already owned). */
  technologies: Record<TechId, { color: string | null; prerequisites: string[] }>;
  /** RR 34/TE breakthrough: commodities max, plus the pair of colors (if any) whose techs can substitute for each other when satisfying prerequisites — never both at once for the same requirement. */
  factions: Record<FactionId, { commoditiesMax: number; breakthroughSynergy: [string, string] | null }>;
  /** RR 90/86: color + prerequisites for unit upgrade techs (data/unitUpgrades.json) — separate from `unitUpgrades` above (which holds COMBAT STATS once owned, and is still an unresolved gap per this project's own notes); this is just enough to validate RR 90.7 prerequisites before letting a player research one. */
  unitUpgradeTechData: Record<UnitUpgradeId, { color: string | null; prerequisites: string[] }>;
  /** Every tech id that's a FACTION technology (data/factions/*.json's factionTechnologies) for any faction in this game, aggregated — needed for "own N faction techs"-style objectives, since Player.technologies doesn't distinguish faction vs. generic techs. */
  factionTechIds: Set<string>;
  /** RR 35: exploration card mechanics (data/explorationCards.json) — attach bonuses are structured (see that file's own note), but a plain one-time `effect` isn't applied, same deferred-content pattern as action/agenda cards. */
  explorationCards: Record<
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
  >;
  // TODO as later phases need them: technologies (prerequisites/effects),
  // actionCards, agendas, objectives, explorationCards, relics,
  // promissoryNotes, strategyCard primary/secondary text, faction
  // abilityIds -> effect implementations.
}

/**
 * Resolves the *current* stats for one of a player's units, accounting for
 * any owned unit upgrade (RR 86.4: the upgrade card's stats fully replace
 * the faction sheet's for that unit type once owned).
 */
export function getUnitStats(
  rules: RuleData,
  factionId: FactionId,
  unitType: UnitType,
  ownedUpgradeIds: UnitUpgradeId[],
): UnitStats | undefined {
  const upgrade = ownedUpgradeIds
    .map((id) => rules.unitUpgrades[id])
    .find((u) => u?.unitType === unitType);
  if (upgrade) return upgrade.stats;
  return rules.factionUnits[factionId]?.baseUnits[unitType];
}
