import { AnomalyType } from "../types/enums";

/**
 * RR 9 ANOMALIES.
 *
 * Ported from the original class-based src/engine/anomalyRules.js (that file
 * and tileModel.js are now fully superseded by this + GameState's plain
 * SystemState.anomalies shape — safe to delete both from the repo once this
 * file and rules/movement.ts are uploaded).
 *
 * Same rules as the original, now as plain functions over `AnomalyType[]`
 * (SystemState.anomalies) instead of methods on a mutable Tile class, so
 * GameState — a plain serializable object — is the only thing callers need
 * to pass around.
 *
 * RR 9.5 (combined anomalies, e.g. tile 82 "Asteroid Field / Alpha
 * Wormhole"): handled for free — every function below just loops over
 * whatever anomaly types are present and applies each rule.
 */

export interface AnomalyMovementRule {
  /** true = always enterable; false = never; "onlyIfActiveSystem" = nebula's rule (can only be entered as the system being activated this tactical action, never as a mid-path stop). */
  canEnter: boolean | "onlyIfActiveSystem";
  canPassThrough: boolean;
  /** Nebula: OVERRIDES (does not add to) a ship's move value to this, when the ship's movement starts in this system. */
  moveValueWhenLeaving?: number;
  /** Gravity Rift: ADDS to a ship's move value. RR 9.7: applies once per ship per tactical action even if its path touches multiple rifts — see rules/movement.ts, which enforces the "once" part; this file just describes the rule. */
  moveValueBonus?: number;
  /** Gravity Rift: after moving out of or through, roll one die per ship; destroyed on a low roll. NOTE: not yet wired up anywhere — rolling dice from a pure GameEngine.applyAction call needs an RNG-input design decision (see rules/movement.ts TODO) shared with space/ground combat, so this is deliberately inert for now rather than half-implemented. */
  destructionCheck?: { diceSides: number; destroyOnRollLessOrEqual: number };
}

export interface AnomalyCombatRule {
  defenderCombatRollBonus: number;
}

export interface AnomalyRuleDefinition {
  label: string;
  movement: AnomalyMovementRule;
  combat: AnomalyCombatRule | null;
}

export const ANOMALY_RULES: Record<AnomalyType, AnomalyRuleDefinition> = {
  asteroidField: {
    label: "Asteroid Field",
    movement: { canEnter: false, canPassThrough: false },
    combat: null,
  },
  nebula: {
    label: "Nebula",
    movement: { canEnter: "onlyIfActiveSystem", canPassThrough: false, moveValueWhenLeaving: 1 },
    combat: { defenderCombatRollBonus: 1 },
  },
  supernova: {
    label: "Supernova",
    movement: { canEnter: false, canPassThrough: false },
    combat: null,
  },
  gravityRift: {
    label: "Gravity Rift",
    movement: {
      canEnter: true,
      canPassThrough: true,
      moveValueBonus: 1,
      destructionCheck: { diceSides: 10, destroyOnRollLessOrEqual: 3 },
    },
    combat: null,
  },
  // Thunder's Edge (TE p.11). Movement/combat effects not yet confirmed
  // against the physical card text — left inert (no restriction) rather
  // than guessed, since a wrong blocking rule is worse than a missing one.
  entropicScar: {
    label: "Entropic Scar",
    movement: { canEnter: true, canPassThrough: true },
    combat: null,
  },
};

/** Can a ship (no special tech) enter this system? `isActiveSystem` must be true only for the system being activated this tactical action — never for a mid-path system. `ignoreAsteroidFields` is Antimass Deflectors' own effect ("your ships can move into and through asteroid fields") — everything else (Supernova, Nebula's active-system-only rule) still applies even with it. */
export function canShipEnterTile(
  anomalies: AnomalyType[],
  opts: { isActiveSystem?: boolean; ignoreAsteroidFields?: boolean } = {},
): boolean {
  const isActiveSystem = opts.isActiveSystem ?? false;
  for (const type of anomalies) {
    if (opts.ignoreAsteroidFields && type === "asteroidField") continue;
    const rule = ANOMALY_RULES[type]?.movement;
    if (!rule) continue;
    if (rule.canEnter === false) return false;
    if (rule.canEnter === "onlyIfActiveSystem" && !isActiveSystem) return false;
  }
  return true;
}

/** Can a ship (no special tech) pass through this system as a mid-path stop? Same Antimass Deflectors carve-out as canShipEnterTile above. */
export function canShipPassThroughTile(anomalies: AnomalyType[], ignoreAsteroidFields = false): boolean {
  return anomalies.every((type) => {
    if (ignoreAsteroidFields && type === "asteroidField") return true;
    return ANOMALY_RULES[type]?.movement.canPassThrough !== false;
  });
}

export function hasGravityRift(anomalies: AnomalyType[]): boolean {
  return anomalies.includes("gravityRift");
}

export function hasNebula(anomalies: AnomalyType[]): boolean {
  return anomalies.includes("nebula");
}

/** RR 9 / combat: defender's per-roll bonus from anomalies present in the combat system (currently only Nebula grants one). */
export function getDefenderCombatBonus(anomalies: AnomalyType[]): number {
  return anomalies.reduce((sum, type) => sum + (ANOMALY_RULES[type]?.combat?.defenderCombatRollBonus ?? 0), 0);
}

/** Gravity Rift's post-move destruction check, if this system has one. Returns null otherwise. Not yet consumed anywhere — see the field's own doc comment. */
export function getGravityRiftDestructionCheck(anomalies: AnomalyType[]) {
  if (!hasGravityRift(anomalies)) return null;
  return ANOMALY_RULES.gravityRift.movement.destructionCheck ?? null;
}
