import { GameState, Player, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, SystemId } from "../types/ids";
import { RuleData, getUnitStats } from "../types/RuleData";
import { canShipReachSystem } from "../rules/movement";
import { playersWithShipsInSystem } from "../rules/combat";

/**
 * RR 78 STEP 1 — ACTIVATION.
 * RR 5.1/5.2: place a tactic-pool command token on a system the player
 * doesn't already have a token in. Sets up `pendingTacticalAction` so the
 * rest of the tactical action (movement, combat, invasion, production) can
 * be resolved across separate async submissions instead of one giant action.
 */
export function activateSystem(
  state: GameState,
  action: { type: "ACTIVATE_SYSTEM"; playerId: PlayerId; systemId: SystemId },
): ActionResult {
  if (state.phase !== "action") {
    return { ok: false, error: "RR 78: tactical actions only happen during the action phase." };
  }
  if (state.activePlayerId !== action.playerId) {
    return { ok: false, error: "RR 4: it is not this player's turn." };
  }
  if (state.pendingTacticalAction) {
    return { ok: false, error: "A tactical action is already in progress; resolve it before activating a new system." };
  }

  const player = state.players[action.playerId];
  if (player.hasPassed) {
    return { ok: false, error: "RR 3.3: this player has already passed for the action phase." };
  }
  if (player.commandTokens.tactic <= 0) {
    return { ok: false, error: "RR 78.1: no command tokens remaining in tactic pool." };
  }
  if (player.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "RR 5.2: a player cannot activate a system that already contains one of his command tokens." };
  }

  const updatedPlayer: Player = {
    ...player,
    commandTokens: {
      ...player.commandTokens,
      tactic: player.commandTokens.tactic - 1,
      onBoard: [...player.commandTokens.onBoard, action.systemId],
    },
  };

  const nextState: GameState = {
    ...state,
    players: { ...state.players, [player.id]: updatedPlayer },
    pendingTacticalAction: {
      playerId: action.playerId,
      systemId: action.systemId,
      step: "movement",
    },
  };

  return {
    ok: true,
    state: nextState,
    events: [{ type: "SYSTEM_ACTIVATED", playerId: action.playerId, systemId: action.systemId }],
  };
}

/**
 * RR 78 STEP 2 — MOVEMENT (RR 58.4 for the per-ship legality rules).
 * Validates and applies ship movement into the active system in one shot
 * (all of a player's moved ships move simultaneously per RR 58.6, so there's
 * no reason to split this into per-ship actions).
 *
 * Reachability (enemy-fleet blocking, RR 9 anomaly entry/pass-through rules,
 * Nebula's move-value clamp, Gravity Rift's move-value bonus) is delegated
 * to rules/movement.ts's canShipReachSystem — see that file for the exact
 * rules it enforces and the one thing it deliberately doesn't (Gravity
 * Rift's destruction die roll, parked pending an RNG-in-pure-engine design
 * decision shared with combat resolution).
 */
export function moveShips(
  state: GameState,
  action: {
    type: "MOVE_SHIPS";
    playerId: PlayerId;
    moves: { fromSystemId: SystemId; unitType: import("../types/enums").UnitType; count: number }[];
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 78: no tactical action in progress for this player." };
  }
  if (pending.step !== "movement") {
    return { ok: false, error: `RR 78: expected step "movement", tactical action is at "${pending.step}".` };
  }

  const player = state.players[action.playerId];
  const activeSystemId = pending.systemId;

  let workingState = state;

  for (const move of action.moves) {
    if (move.fromSystemId === activeSystemId) continue; // already there, nothing to validate

    // RR 49.4 bullet: cannot move ships out of a system containing one of the player's own command tokens.
    if (player.commandTokens.onBoard.includes(move.fromSystemId)) {
      return {
        ok: false,
        error: `RR 49.4: cannot move ships out of ${move.fromSystemId} — it contains this player's own command token.`,
      };
    }

    const stats = getUnitStats(rules, player.factionId, move.unitType, player.unitUpgrades);
    if (!stats || stats.move === null) {
      return { ok: false, error: `${move.unitType} has no move value and cannot move.` };
    }

    if (!canShipReachSystem(workingState, player.id, move.fromSystemId, activeSystemId, stats.move)) {
      return {
        ok: false,
        error: `RR 58.4: ${move.unitType} at ${move.fromSystemId} cannot reach ${activeSystemId} (move value ${stats.move}) — blocked by an anomaly, an enemy fleet along the way, or simply out of range.`,
      };
    }

    const originSystem = workingState.systems[move.fromSystemId];
    const originStack = originSystem?.spaceUnitsByPlayer[player.id]?.find((s) => s.unitType === move.unitType);
    if (!originStack || originStack.count < move.count) {
      return { ok: false, error: `Not enough ${move.unitType} at ${move.fromSystemId} to move ${move.count}.` };
    }

    workingState = removeFromSystem(workingState, move.fromSystemId, player.id, move.unitType, move.count);
    workingState = addToSystem(workingState, activeSystemId, player.id, move.unitType, move.count);
  }

  // RR 78.2 bullet: after moving, space cannon offense may fire, then space
  // combat resolves if 2+ players have ships in the active system (RR 78.3).
  // For this first pass we skip straight to whichever comes next; those
  // steps are the next TODOs in this file's neighborhood.
  const nextStep = playersWithShipsInSystem(workingState, activeSystemId).length > 1 ? "spaceCombat" : "invasion";

  workingState = {
    ...workingState,
    pendingTacticalAction: { ...pending, step: nextStep },
  };

  return {
    ok: true,
    state: workingState,
    events: [{ type: "SHIPS_MOVED", playerId: action.playerId, toSystemId: activeSystemId }],
  };
}

// --- helpers -------------------------------------------------------------

function removeFromSystem(
  state: GameState,
  systemId: SystemId,
  playerId: PlayerId,
  unitType: import("../types/enums").UnitType,
  count: number,
): GameState {
  const system = state.systems[systemId];
  const stacks = system.spaceUnitsByPlayer[playerId] ?? [];
  const updatedStacks = stacks
    .map((s) => (s.unitType === unitType ? { ...s, count: s.count - count } : s))
    .filter((s) => s.count > 0);

  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [playerId]: updatedStacks },
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}

function addToSystem(
  state: GameState,
  systemId: SystemId,
  playerId: PlayerId,
  unitType: import("../types/enums").UnitType,
  count: number,
): GameState {
  const system = state.systems[systemId];
  const stacks = system.spaceUnitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType && !s.upgradeId);
  const updatedStacks = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + count } : s))
    : [...stacks, { unitType, count, damagedCount: 0 }];

  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [playerId]: updatedStacks },
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}
