import { GameState, Player, SystemState, UnitStack } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, SystemId } from "../types/ids";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getAdjacentSystems } from "../rules/adjacency";

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
 * RR 78 STEP 2 — MOVEMENT (RR 49.4 for the per-ship legality rules).
 * Validates and applies ship movement into the active system in one shot
 * (all of a player's moved ships move simultaneously per RR 49.6, so there's
 * no reason to split this into per-ship actions).
 *
 * Deliberately NOT yet implemented: RR 49.4 bullet "the ship cannot move
 * through a system that contains non-fighter ships controlled by another
 * player" — that requires pathfinding across boardAdjacency to enumerate the
 * systems actually crossed, not just checked as a single origin/destination
 * hop. Flagged with a TODO below rather than silently ignored, since
 * shipping this without it would let a player illegally move through a
 * blockading fleet.
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

    // Simplification for this pass: treats reachability as "adjacent within
    // `stats.move` hops via a naive adjacency check" rather than full
    // shortest-path routing (gravity rifts' +1 bonus, nebula's move=1 clamp,
    // and asteroid/supernova blocking are also not yet applied here — see
    // TODO above). Good enough to unblock UI wiring; must be hardened
    // before this ships to real games.
    if (!isWithinRange(workingState, move.fromSystemId, activeSystemId, stats.move)) {
      return {
        ok: false,
        error: `RR 49.3/49.4: ${move.unitType} at ${move.fromSystemId} cannot reach ${activeSystemId} (move value ${stats.move}).`,
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

function isWithinRange(state: GameState, from: SystemId, to: SystemId, moveValue: number): boolean {
  if (from === to) return true;
  if (moveValue <= 0) return false;
  const visited = new Set<SystemId>([from]);
  let frontier = [from];
  for (let hop = 0; hop < moveValue; hop++) {
    const next: SystemId[] = [];
    for (const sys of frontier) {
      for (const neighbor of getNeighbors(state, sys)) {
        if (neighbor === to) return true;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return false;
}

function getNeighbors(state: GameState, systemId: SystemId): SystemId[] {
  return getAdjacentSystems(state, systemId);
}

function playersWithShipsInSystem(state: GameState, systemId: SystemId): PlayerId[] {
  const system = state.systems[systemId];
  if (!system) return [];
  return Object.entries(system.spaceUnitsByPlayer)
    .filter(([, stacks]) => (stacks as UnitStack[]).some((s) => s.count > 0))
    .map(([playerId]) => playerId as PlayerId);
}

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
