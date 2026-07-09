import { GameState, PendingTacticalAction, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { isAdjacent } from "../rules/adjacency";
import {
  playersWithShipsInSystem,
  buildSpaceCombatEntries,
  resolveCombatRound,
  applyHitAssignments,
} from "../rules/combat";

/**
 * RR 78 STEP 3 — SPACE COMBAT (RR 67).
 * Three actions cover a round: ANNOUNCE_RETREAT (optional, before dice),
 * RESOLVE_COMBAT_ROUND (rolls dice), ASSIGN_HITS (each affected player
 * spends their hits). The round loops (combatRound += 1) until one side has
 * no ships left or a retreat actually executes; then the tactical action
 * moves on to "invasion" per RR 78's step order.
 *
 * NOT implemented yet, flagged rather than silently skipped:
 *  - Anti-Fighter Barrage's separate pre-round dice pool (RR 67.1, round 1
 *    only, fighters only).
 *  - Capacity overflow: if this destroys every ship that was carrying
 *    fighters/ground forces, those cargo units should be destroyed too
 *    (RR "Capacity") unless another surviving ship here has spare capacity.
 *    Ground-forces-in-transit isn't represented in GameState yet at all
 *    (see moveShips' TODO on transportedGroundForces/transportedFighters) —
 *    this needs solving together with the Invasion step, not bolted on here.
 *  - 3+ players' ships in one combat (buildSpaceCombatEntries already
 *    throws rather than guess which 2 fight first).
 */

export function announceRetreat(
  state: GameState,
  action: { type: "ANNOUNCE_RETREAT"; playerId: PlayerId; toSystemId: SystemId },
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: "RR 67.4: no tactical action in progress." };
  if (pending.step !== "spaceCombat") {
    return { ok: false, error: `RR 67.4: retreat only applies during space combat, current step is "${pending.step}".` };
  }
  if (pending.pendingHits && Object.keys(pending.pendingHits).length > 0) {
    return { ok: false, error: "RR 67.4: retreat must be announced before this round's hits are assigned." };
  }

  const combatants = playersWithShipsInSystem(state, pending.systemId);
  if (!combatants.includes(action.playerId)) {
    return { ok: false, error: "RR 67.4: this player has no ships in this combat." };
  }
  if (pending.retreating?.some((r) => r.playerId === action.playerId)) {
    return { ok: false, error: "This player has already announced a retreat this round." };
  }
  if (!isAdjacent(state, pending.systemId, action.toSystemId)) {
    return { ok: false, error: "RR 67.4: retreat destination must be adjacent to the combat system." };
  }
  const blockers = playersWithShipsInSystem(state, action.toSystemId).filter((p) => p !== action.playerId);
  if (blockers.length > 0) {
    return { ok: false, error: "RR 67.4: cannot retreat into a system that contains another player's ships." };
  }

  const nextPending: PendingTacticalAction = {
    ...pending,
    retreating: [...(pending.retreating ?? []), { playerId: action.playerId, toSystemId: action.toSystemId }],
  };

  return {
    ok: true,
    state: { ...state, pendingTacticalAction: nextPending },
    events: [{ type: "RETREAT_ANNOUNCED", playerId: action.playerId, toSystemId: action.toSystemId }],
  };
}

export function resolveSpaceCombatRound(
  state: GameState,
  action: { type: "RESOLVE_COMBAT_ROUND"; playerId: PlayerId; diceRolls: number[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: "RR 67.5: no tactical action in progress." };
  if (pending.step !== "spaceCombat") {
    return { ok: false, error: `RR 67.5: expected step "spaceCombat", got "${pending.step}".` };
  }
  if (pending.pendingHits && Object.keys(pending.pendingHits).length > 0) {
    return { ok: false, error: "RR 67.6: the previous round's hits haven't all been assigned yet." };
  }

  const systemId = pending.systemId;
  const combatants = playersWithShipsInSystem(state, systemId);
  if (!combatants.includes(action.playerId)) {
    return { ok: false, error: "RR 67.5: only a player with ships in this combat can submit its dice roll." };
  }

  let entries;
  try {
    entries = buildSpaceCombatEntries(state, rules, systemId, pending.playerId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let result;
  try {
    result = resolveCombatRound(entries, action.diceRolls);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Hits scored BY one side land on the OTHER side — valid because
  // buildSpaceCombatEntries already restricts this to exactly 2 combatants.
  const [a, b] = combatants;
  const pendingHits: Partial<Record<PlayerId, number>> = {};
  if (result.hitsScoredByPlayer[a]) pendingHits[b] = result.hitsScoredByPlayer[a];
  if (result.hitsScoredByPlayer[b]) pendingHits[a] = result.hitsScoredByPlayer[b];

  const round = pending.combatRound ?? 1;
  let nextState: GameState = {
    ...state,
    pendingTacticalAction: { ...pending, combatRound: round, pendingHits },
  };

  const events: GameEvent[] = [
    { type: "COMBAT_ROUND_RESOLVED", systemId, round, hitsScoredByPlayer: result.hitsScoredByPlayer },
  ];

  // Nobody hit anything — nothing to assign, go straight to end-of-round checks.
  if (Object.keys(pendingHits).length === 0) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }

  return { ok: true, state: nextState, events };
}

export function assignHits(
  state: GameState,
  action: { type: "ASSIGN_HITS"; playerId: PlayerId; assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: "RR 67.6/38.2: no tactical action in progress." };
  if (pending.step !== "spaceCombat") {
    return { ok: false, error: `RR 67.6: expected step "spaceCombat", got "${pending.step}".` };
  }
  const hitsOwed = pending.pendingHits?.[action.playerId];
  if (!hitsOwed || hitsOwed <= 0) {
    return { ok: false, error: "This player has no pending hits to assign right now." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const player = state.players[action.playerId];
  const stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []) as UnitStack[];

  const result = applyHitAssignments(stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR 67.6: ${result.error}` };

  const events: GameEvent[] = [
    ...Array.from(result.destroyed.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, unitType, count }),
    ),
    ...Array.from(result.flipped.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNIT_SUSTAINED_DAMAGE", playerId: action.playerId, systemId, unitType, count }),
    ),
  ];

  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: result.stacks },
  };

  const remainingPendingHits = { ...pending.pendingHits };
  delete remainingPendingHits[action.playerId];

  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits },
  };

  if (Object.keys(remainingPendingHits).length === 0) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }

  return { ok: true, state: nextState, events };
}

// --- helpers ---------------------------------------------------------------

/** Called once every player owed hits this round has submitted ASSIGN_HITS. Executes any announced retreats, then either ends space combat (advances to "invasion") or starts the next round. */
function wrapUpCombatRound(state: GameState, _rules: RuleData): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingTacticalAction;
  if (!pending) return { state, events: [] };
  const systemId = pending.systemId;
  const events: GameEvent[] = [];

  let nextState = state;
  for (const r of pending.retreating ?? []) {
    const stillHasShips = (nextState.systems[systemId].spaceUnitsByPlayer[r.playerId] ?? []).length > 0;
    if (!stillHasShips) continue; // wiped out this round before retreating
    nextState = moveAllShips(nextState, systemId, r.toSystemId, r.playerId);
  }

  const survivors = playersWithShipsInSystem(nextState, systemId);

  if (survivors.length <= 1) {
    nextState = {
      ...nextState,
      pendingTacticalAction: { playerId: pending.playerId, systemId, step: "invasion" },
    };
    events.push({ type: "SPACE_COMBAT_ENDED", systemId, survivingPlayerId: survivors[0] ?? null });
    return { state: nextState, events };
  }

  nextState = {
    ...nextState,
    pendingTacticalAction: {
      ...pending,
      combatRound: (pending.combatRound ?? 1) + 1,
      pendingHits: {},
      retreating: [],
    },
  };
  return { state: nextState, events };
}

function moveAllShips(state: GameState, fromSystemId: SystemId, toSystemId: SystemId, playerId: PlayerId): GameState {
  const fromSystem = state.systems[fromSystemId];
  const toSystem = state.systems[toSystemId];
  const movingStacks = fromSystem.spaceUnitsByPlayer[playerId] ?? [];

  const updatedFrom: SystemState = {
    ...fromSystem,
    spaceUnitsByPlayer: { ...fromSystem.spaceUnitsByPlayer, [playerId]: [] },
  };
  const updatedTo: SystemState = {
    ...toSystem,
    spaceUnitsByPlayer: {
      ...toSystem.spaceUnitsByPlayer,
      [playerId]: mergeStacks(toSystem.spaceUnitsByPlayer[playerId] ?? [], movingStacks),
    },
  };

  return { ...state, systems: { ...state.systems, [fromSystemId]: updatedFrom, [toSystemId]: updatedTo } };
}

function mergeStacks(a: UnitStack[], b: UnitStack[]): UnitStack[] {
  const merged = a.map((s) => ({ ...s }));
  for (const stack of b) {
    const existing = merged.find((s) => s.unitType === stack.unitType && s.upgradeId === stack.upgradeId);
    if (existing) {
      existing.count += stack.count;
      existing.damagedCount += stack.damagedCount;
    } else {
      merged.push({ ...stack });
    }
  }
  return merged;
}
