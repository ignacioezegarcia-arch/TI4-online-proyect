/**
 * Closed-set enums shared across the engine.
 * Each is annotated with the Rules Reference (RR) section it encodes, so
 * when a rule changes you know exactly what to grep for.
 */

/** Which expansions are active. Matches the `set` field convention already used in data/*.json. */
export type GameMode = "base" | "pok" | "pok_te";

/** RR 36: A game round consists of these four phases, in order. */
export type Phase = "setup" | "strategy" | "action" | "status" | "agenda" | "ended";

/** RR 78: The steps of a tactical action, in order. */
export type TacticalStep =
  | "activation"
  | "movement"
  | "spaceCannonOffense"
  | "spaceCombat"
  | "invasion"
  | "production";

/** RR 44: Sub-steps of the invasion step. */
export type InvasionStep =
  | "bombardment"
  | "commitGroundForces"
  | "spaceCannonDefense"
  | "groundCombat"
  | "establishControl";

/** RR 67: Sub-steps of a single round of space combat. Repeats until one side has no ships. */
export type SpaceCombatStep =
  | "antiFighterBarrage"
  | "announceRetreats"
  | "rollDice"
  | "assignHits"
  | "retreat";

/** The three command token pools on a player's command sheet (RR 18). */
export type CommandPool = "tactic" | "fleet" | "strategy";

/** RR 79.7: the four technology colors, used for prerequisites. */
export type TechColor = "biotic" | "warfare" | "propulsion" | "cybernetic";

/** RR 55.3 / Learn to Play p.19: planet traits. Purely descriptive, referenced by cards/abilities. */
export type PlanetTrait = "cultural" | "hazardous" | "industrial";

/** RR 9.2 / TE p.11: anomaly types. entropicScar is Thunder's Edge only. */
export type AnomalyType = "asteroidField" | "nebula" | "supernova" | "gravityRift" | "entropicScar";

/** RR 89 / TE reference: wormhole types. delta is PoK (Creuss), gamma is the Wormhole Nexus. */
export type WormholeType = "alpha" | "beta" | "gamma" | "delta";

/** RR 65 / TI4 base unit roster. Values match the `id` field in data/units.json
 *  exactly (snake_case) so the engine can index into that file directly
 *  without a translation layer. Faction-specific unit *names* differ
 *  (e.g. "Sol Infantry" / "Spec Ops") but they always map back to one of
 *  these functional types for rules purposes. */
export type UnitType =
  | "fighter"
  | "infantry"
  | "destroyer"
  | "cruiser"
  | "carrier"
  | "dreadnought"
  | "war_sun" // not in units.json's base roster — only reachable via the "war_sun" unit-upgrade tech, see RuleData
  | "flagship"
  | "mech" // PoK
  | "pds"
  | "space_dock";

export const SHIP_TYPES: readonly UnitType[] = [
  "fighter",
  "destroyer",
  "cruiser",
  "carrier",
  "dreadnought",
  "war_sun",
  "flagship",
];
export const GROUND_FORCE_TYPES: readonly UnitType[] = ["infantry", "mech"];
export const STRUCTURE_TYPES: readonly UnitType[] = ["pds", "space_dock"];

/** RR 1.22: unit abilities the engine has to special-case (each is a distinct resolution step). */
export type UnitAbility =
  | "antiFighterBarrage"
  | "bombardment"
  | "planetaryShield"
  | "production"
  | "spaceCannon"
  | "sustainDamage";

/** RR 72.5: the eight base strategy cards plus their RR-defined initiative numbers.
 *  Kept as a const map (not just a union) because initiative order is a rule, not a UI concern. */
export const STRATEGY_CARDS = {
  leadership: 1,
  diplomacy: 2,
  politics: 3,
  construction: 4,
  trade: 5,
  warfare: 6,
  technology: 7,
  imperial: 8,
} as const;
export type BaseStrategyCard = keyof typeof STRATEGY_CARDS;

/** RR 52.1: objective category. */
export type ObjectiveKind = "publicI" | "publicII" | "secret";

/** RR 52.3: when an objective can be scored. */
export type ObjectiveTiming = "actionPhase" | "statusPhase" | "agendaPhase";
