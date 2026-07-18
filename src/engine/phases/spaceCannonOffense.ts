import { GameState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, asTechId } from "../types/ids";
import { UnitType, SHIP_TYPES } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { buildSpaceCannonOffenseEntries, resolveCombatRound, applyHitAssignments, applySelfAssemblyRoutinesMechBonus, playersWithShipsInSystem } from "../rules/combat";
import { computeSpaceCombatEntry } from "./spaceCombat";

/**
 * RR 77 SPACE CANNON OFFENSE. Happens once, right after movement, before
 * space combat/invasion. Every eligible player (see
 * rules/combat.ts's getSpaceCannonOffenseEligiblePlayers — this can include
 * players with no ships or forces anywhere near this fight) decides
 * independently: fire, or skip. Order between responders doesn't matter
 * rules-wise; this just processes whoever calls in whatever order they do,
 * one at a time, requiring the active player's hits to be assigned before
 * the next responder can act (keeps state simple — never more than one
 * responder's hits pending at once).
 *
 * NOT modeled: a card/ability that grants a Space Cannon roll to a unit
 * that doesn't actually have the ability — same category of gap as
 * PLAY_ACTION_CARD not existing yet.
 */

export function useSpaceCannonOffense(
  state: GameState,
  action: {
    type: "USE_SPACE_CANNON_OFFENSE";
    playerId: PlayerId;
    diceRolls: number[];
    plasmaScoringUnitType?: UnitType;
    /** RR "Graviton Laser System": exhaust that tech (if owned and readied) before firing, so the ACTIVE player's assignment of these hits must go to non-fighter ships if any are available (enforced in assignSpaceCannonOffenseHits). Only meaningful here (not Space Cannon Defense — that fires at ground forces, which are never fighters). */
    useGravitonLaserSystem?: boolean;
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCannonOffense") {
    return { ok: false, error: "RR 77: no Space Cannon Offense window currently open." };
  }
  const responders = pending.spaceCannonOffenseRespondersRemaining ?? [];
  if (!responders.includes(action.playerId)) {
    return { ok: false, error: "This player isn't eligible to use Space Cannon Offense right now (already decided, or doesn't qualify)." };
  }
  if (Object.keys(pending.pendingHits ?? {}).length > 0) {
    return { ok: false, error: "RR 77: resolve the previous responder's hits before the next one fires." };
  }

  const entries = buildSpaceCannonOffenseEntries(state, rules, action.playerId, pending.systemId, pending.playerId, action.plasmaScoringUnitType);
  if (entries.length === 0) {
    return { ok: false, error: "This player has no qualifying Space Cannon units." };
  }

  let workingState = state;
  if (action.useGravitonLaserSystem) {
    const techId = asTechId("graviton_laser_system");
    const player = state.players[action.playerId];
    if (!player.technologies.includes(techId)) return { ok: false, error: "This player doesn't own Graviton Laser System." };
    if (player.exhaustedTechnologies.includes(techId)) return { ok: false, error: "Graviton Laser System is already exhausted." };
    workingState = { ...workingState, players: { ...workingState.players, [action.playerId]: { ...player, exhaustedTechnologies: [...player.exhaustedTechnologies, techId] } } };
  }

  let result;
  try {
    result = resolveCombatRound(entries, action.diceRolls);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const hits = result.hitsScoredByPlayer[action.playerId] ?? 0;

  const remainingResponders = responders.filter((id) => id !== action.playerId);
  const events: GameEvent[] = [{ type: "SPACE_CANNON_OFFENSE_FIRED", playerId: action.playerId, systemId: pending.systemId, hits }];

  const nextState: GameState = {
    ...workingState,
    pendingTacticalAction: {
      ...pending,
      spaceCannonOffenseRespondersRemaining: remainingResponders,
      pendingHits: hits > 0 ? { [pending.playerId]: hits } : {},
      gravitonLaserSystemRestrictsPendingHits: hits > 0 ? Boolean(action.useGravitonLaserSystem) : false,
    },
  };

  if (hits === 0 && remainingResponders.length === 0) {
    const advanced = advanceFromSpaceCannonOffense(nextState, rules);
    return { ok: true, state: advanced.state, events: [...events, ...advanced.events] };
  }

  return { ok: true, state: nextState, events };
}

export function skipSpaceCannonOffense(
  state: GameState,
  action: { type: "SKIP_SPACE_CANNON_OFFENSE"; playerId: PlayerId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCannonOffense") {
    return { ok: false, error: "RR 77: no Space Cannon Offense window currently open." };
  }
  const responders = pending.spaceCannonOffenseRespondersRemaining ?? [];
  if (!responders.includes(action.playerId)) {
    return { ok: false, error: "This player isn't eligible to decide on Space Cannon Offense right now." };
  }

  const remainingResponders = responders.filter((id) => id !== action.playerId);
  const nextState: GameState = {
    ...state,
    pendingTacticalAction: { ...pending, spaceCannonOffenseRespondersRemaining: remainingResponders },
  };
  const events: GameEvent[] = [{ type: "SPACE_CANNON_OFFENSE_SKIPPED", playerId: action.playerId }];

  if (remainingResponders.length === 0 && Object.keys(pending.pendingHits ?? {}).length === 0) {
    const advanced = advanceFromSpaceCannonOffense(nextState, rules);
    return { ok: true, state: advanced.state, events: [...events, ...advanced.events] };
  }

  return { ok: true, state: nextState, events };
}

export function assignSpaceCannonOffenseHits(
  state: GameState,
  action: {
    type: "ASSIGN_SPACE_CANNON_OFFENSE_HITS";
    playerId: PlayerId;
    assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCannonOffense") {
    return { ok: false, error: "RR 77: no Space Cannon Offense window currently open." };
  }
  const hitsOwed = pending.pendingHits?.[action.playerId];
  if (!hitsOwed || hitsOwed <= 0) {
    return { ok: false, error: "This player has no pending Space Cannon Offense hits to assign." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const player = state.players[action.playerId];
  const stacks = system.spaceUnitsByPlayer[action.playerId] ?? [];

  // RR "Graviton Laser System": if the firing player exhausted it before
  // this shot, these hits must go to non-fighter ships first, while any
  // remain — checked here (assignment time), not at fire time, since
  // that's when the actual unit stacks are known.
  if (pending.gravitonLaserSystemRestrictsPendingHits) {
    const nonFighterShipUnitsAvailable = stacks
      .filter((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter")
      .reduce((sum, s) => sum + s.count, 0);
    const nonFighterAssignments = action.assignments.filter((a) => a.unitType !== "fighter").length;
    const fighterAssignments = action.assignments.filter((a) => a.unitType === "fighter").length;
    if (fighterAssignments > 0 && nonFighterAssignments < nonFighterShipUnitsAvailable) {
      return { ok: false, error: 'RR "Graviton Laser System": these hits must be assigned to non-fighter ships first, while any remain.' };
    }
  }

  const result = applyHitAssignments(stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR 77: ${result.error}` };

  const events: GameEvent[] = [
    ...Array.from(result.destroyed.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, unitType, count }),
    ),
    ...Array.from(result.flipped.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNIT_SUSTAINED_DAMAGE", playerId: action.playerId, systemId, unitType, count }),
    ),
  ];

  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: result.stacks } };
  const remainingPendingHits = { ...pending.pendingHits };
  delete remainingPendingHits[action.playerId];

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    // RR "Self-Assembly Routines": normally mechs never appear in space
    // (ground forces only), but some factions have abilities that let
    // their mechs sit in the space area too — wired in for that case.
    players: { ...state.players, [action.playerId]: applySelfAssemblyRoutinesMechBonus(player, result.destroyed) },
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits, gravitonLaserSystemRestrictsPendingHits: false },
  };

  const respondersLeft = pending.spaceCannonOffenseRespondersRemaining ?? [];
  if (respondersLeft.length === 0 && Object.keys(remainingPendingHits).length === 0) {
    const advanced = advanceFromSpaceCannonOffense(nextState, rules);
    return { ok: true, state: advanced.state, events: [...events, ...advanced.events] };
  }

  return { ok: true, state: nextState, events };
}

function advanceFromSpaceCannonOffense(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingTacticalAction!;
  const willHaveCombat = playersWithShipsInSystem(state, pending.systemId).length > 1;
  const nextState: GameState = {
    ...state,
    pendingTacticalAction: willHaveCombat
      ? { playerId: pending.playerId, systemId: pending.systemId, step: "spaceCombat", ...computeSpaceCombatEntry(state, rules, pending.systemId, pending.playerId) }
      : { playerId: pending.playerId, systemId: pending.systemId, step: "invasion" },
  };
  return { state: nextState, events: [] };
}
