import { FactionId, AgendaId, ObjectiveId, PlanetId, TechId, UnitUpgradeId } from "./ids";
import { ObjectiveKind, UnitAbility, UnitType } from "./enums";

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
  /** e.g. Anti-Fighter Barrage X(Y) -> {value: X, dice: Y}; Bombardment 5 -> {value:5, dice:1}. Keyed by ability for units with more than one. `rangesToAdjacent` is Space-Cannon-specific (RR: PDS II's own upgrade text) — true means this unit's Space Cannon can target ships in adjacent systems too, not just its own. */
  abilityValues?: Partial<Record<UnitAbility, { value: number; dice: number; rangesToAdjacent?: boolean }>>;
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
  /** RR PoK "Wormhole Nexus": true only for Mallice, the Nexus's own planet. Needed to trigger the Nexus's active-flip on control gain (see rules/adjacency.ts's maybeActivateWormholeNexus). */
  isMallice: boolean;
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
  /** RR 52.1: publicI/publicII/secret — needed at setup to split rules.objectives back out into the right starting decks (see setup/createGame.ts's shuffleAndSeedDecks). */
  kind: ObjectiveKind;
}

export interface RuleData {
  factionUnits: Record<FactionId, FactionUnitStats>;
  unitUpgrades: Record<UnitUpgradeId, UnitUpgradeStats>;
  /** Static resources/influence per planet (data/tiles.json), keyed by the same lowercase-underscore id as PlanetId (e.g. "jord", "mecatol_rex"). */
  planets: Record<PlanetId, PlanetStaticData>;
  /** RR 7: only the law-vs-directive split (data/agendas.json) — NOT the outcome/effect text, same "mechanics only" scope cut as objectives (see data/objectives.json's own note). Needed just to know whether a resolved agenda becomes a permanent law or gets discarded after one use. */
  agendas: Record
