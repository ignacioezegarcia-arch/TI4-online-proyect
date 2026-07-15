import { GameState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { buildSpaceCannonOffenseEntries, resolveCombatRound, applyHitAssignments, playersWithShipsInSystem } from "../rules/combat";

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
  action: { type: "USE_SPACE_CANNON_OFFENSE"; playerId: PlayerId; diceRolls: number[] },
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

  const entries = buildSpaceCannonOffenseEntries(state, rules, action.playerId, pending.systemId);
  if (entries.length === 0) {
    return { ok: false, error: "This player has no qualifying Space Cannon units." };
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
    ...state,
    pendingTacticalAction: {
      ...pending,
      spaceCannonOffenseRespondersRemaining: remainingResponders,
      pendingHits: hits > 0 ? { [pending.playerId]: hits } : {},
    },
  };

  if (hits === 0 && remainingResponders.length === 0) {
    const advanced = advanceFromSpaceCannonOffense(nextState);
    return { ok: true, state: advanced.state, events: [...events, ...advanced.events] };
  }

  return { ok: true, state: nextState, events };
}

export function skipSpaceCannonOffense(
  state: GameState,
  action: { type: "SKIP_SPACE_CANNON_OFFENSE"; playerId: PlayerId },
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
    const advanced = advanceFromSpaceCannonOffense(nextState);
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
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits },
  };

  const respondersLeft = pending.spaceCannonOffenseRespondersRemaining ?? [];
  if (respondersLeft.length === 0 && Object.keys(remainingPendingHits).length === 0) {
    const advanced = advanceFromSpaceCannonOffense(nextState);
    return { ok: true, state: advanced.state, events: [...events, ...advanced.events] };
  }

  return { ok: true, state: nextState, events };
}

function advanceFromSpaceCannonOffense(state: GameState): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingTacticalAction!;
  const nextStep = playersWithShipsInSystem(state, pending.systemId).length > 1 ? "spaceCombat" : "invasion";
  const nextState: GameState = {
    ...state,
    pendingTacticalAction: { playerId: pending.playerId, systemId: pending.systemId, step: nextStep },
  };
  return { state: nextState, events: [] };
}
