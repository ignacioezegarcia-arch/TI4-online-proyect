import { GameState, Player, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, SystemId, asTechId } from "../types/ids";
import { RuleData, getUnitStats } from "../types/RuleData";
import { canShipReachSystem } from "../rules/movement";
import { maybeActivateWormholeNexus } from "../rules/adjacency";
import { playersWithShipsInSystem, getSpaceCannonOffenseEligiblePlayers } from "../rules/combat";
import { computeSpaceCombatEntry } from "./spaceCombat";

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
    // RR 52-adjacent: see GameState.ts's own doc comment on recentEvents —
    // a new tactical action starting is the reset point for that buffer.
    recentEvents: [],
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
    transportedGroundForces?: { fromSystemId: SystemId; unitType: "infantry" | "mech"; count: number }[];
    transportedFighters?: { fromSystemId: SystemId; count: number }[];
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

    if (
      !canShipReachSystem(workingState, player.id, move.fromSystemId, activeSystemId, stats.move, {
        ignoreAsteroidFields: player.technologies.includes(asTechId("antimass_deflectors")),
        ignoreEnemyFleets: player.technologies.includes(asTechId("light_wave_deflector")),
      })
    ) {
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

  // RR 84.1 — cargo (ground forces + fighters) riding along with the moving
  // ships. Simplification, flagged rather than silently wrong: each cargo
  // entry must originate from the SAME system as one of this action's own
  // `moves` entries — picking up cargo at an intermediate hop mid-path (RR
  // 84.1 technically allows this) isn't supported yet. Capacity (total
  // cargo can't exceed the sum of capacity across the ships actually
  // making this move) also isn't enforced yet — flagged, not silently
  // ignored, same as the retreat/AFB/action-card gaps elsewhere in this
  // file's neighborhood.
  const moveOrigins = new Set(action.moves.map((m) => m.fromSystemId));

  for (const cargo of action.transportedGroundForces ?? []) {
    if (!moveOrigins.has(cargo.fromSystemId)) {
      return {
        ok: false,
        error: `RR 84.1: transported ground forces must come from a system this action is already moving ships from (${cargo.fromSystemId} isn't one of them).`,
      };
    }
    const originStack = workingState.systems[cargo.fromSystemId]?.spaceUnitsByPlayer[player.id]?.find(
      (s) => s.unitType === cargo.unitType,
    );
    if (!originStack || originStack.count < cargo.count) {
      return { ok: false, error: `Not enough ${cargo.unitType} at ${cargo.fromSystemId} to transport ${cargo.count}.` };
    }
    workingState = removeFromSystem(workingState, cargo.fromSystemId, player.id, cargo.unitType, cargo.count);
    workingState = addToSystem(workingState, activeSystemId, player.id, cargo.unitType, cargo.count);
  }

  for (const cargo of action.transportedFighters ?? []) {
    if (!moveOrigins.has(cargo.fromSystemId)) {
      return {
        ok: false,
        error: `RR 84.1: transported fighters must come from a system this action is already moving ships from (${cargo.fromSystemId} isn't one of them).`,
      };
    }
    const originStack = workingState.systems[cargo.fromSystemId]?.spaceUnitsByPlayer[player.id]?.find(
      (s) => s.unitType === "fighter",
    );
    if (!originStack || originStack.count < cargo.count) {
      return { ok: false, error: `Not enough fighters at ${cargo.fromSystemId} to transport ${cargo.count}.` };
    }
    workingState = removeFromSystem(workingState, cargo.fromSystemId, player.id, "fighter", cargo.count);
    workingState = addToSystem(workingState, activeSystemId, player.id, "fighter", cargo.count);
  }

  // RR 78.2: after moving, ANY player with a qualifying PDS may use Space
  // Cannon Offense against the active player's ships before combat (RR
  // 77) — not just this player's own units, and not gated on whether
  // space combat will even happen (a lone PDS owner passing through with
  // no stake in this system can still fire). If nobody qualifies, skip
  // straight through to spaceCombat/invasion as before.
  // RR PoK "Wormhole Nexus": if this move just brought a ship there for the
  // first time, it flips active at the END of this step (not mid-move) —
  // hence doing this last, right before returning.
  workingState = maybeActivateWormholeNexus(workingState, rules, activeSystemId);

  const spaceCannonResponders = getSpaceCannonOffenseEligiblePlayers(workingState, rules, activeSystemId, player.id);
  const willHaveCombat = playersWithShipsInSystem(workingState, activeSystemId).length > 1;

  workingState = {
    ...workingState,
    pendingTacticalAction:
      spaceCannonResponders.length > 0
        ? { ...pending, step: "spaceCannonOffense", spaceCannonOffenseRespondersRemaining: spaceCannonResponders }
        : willHaveCombat
          ? { ...pending, step: "spaceCombat", ...computeSpaceCombatEntry(workingState, rules, activeSystemId) }
          : { ...pending, step: "invasion" },
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
