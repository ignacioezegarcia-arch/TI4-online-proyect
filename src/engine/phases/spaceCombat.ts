import { GameState, PendingTacticalAction, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, asTechId } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { isAdjacent } from "../rules/adjacency";
import {
  playersWithShipsInSystem,
  buildSpaceCombatEntries,
  resolveCombatRound,
  applyHitAssignments,
  applySelfAssemblyRoutinesMechBonus,
  getAntiFighterBarrageParticipants,
  buildAntiFighterBarrageEntries,
} from "../rules/combat";

/**
 * RR 78 STEP 3 — SPACE COMBAT (RR 67).
 * Sequence per this file: (once, if anyone qualifies) Anti-Fighter Barrage
 * — ANNOUNCE_RETREAT (optional, before dice) — RESOLVE_COMBAT_ROUND (rolls
 * dice) — ASSIGN_HITS (each affected player spends their hits). The round
 * loops (combatRound += 1) until one side has no ships left or a retreat
 * actually executes; then the tactical action moves on to "invasion" per
 * RR 78's step order.
 *
 * Entering this step (from tacticalAction.ts's moveShips, or from
 * phases/spaceCannonOffense.ts once that step clears) always goes through
 * computeSpaceCombatEntry below, so AFB eligibility is checked exactly once
 * in one place regardless of which step led here.
 *
 * NOT implemented yet, flagged rather than silently skipped:
 *  - A card/ability granting an AFB roll to a unit that doesn't actually
 *    have the ability — same category of gap as PLAY_ACTION_CARD not
 *    existing yet.
 *  - Capacity overflow: if this destroys every ship that was carrying
 *    fighters/ground forces, those cargo units should be destroyed too
 *    (RR "Capacity") unless another surviving ship here has spare capacity.
 *    Ground-forces-in-transit isn't represented in GameState yet at all
 *    (see moveShips' TODO on transportedGroundForces/transportedFighters) —
 *    this needs solving together with the Invasion step, not bolted on here.
 *  - 3+ players' ships in one combat (buildSpaceCombatEntries already
 *    throws rather than guess which 2 fight first).
 */

/** Called whenever a tactical action's pendingTacticalAction is about to become step "spaceCombat", from wherever that transition happens — so AFB eligibility is computed exactly once, consistently. */
export function computeSpaceCombatEntry(
  state: GameState,
  rules: RuleData,
  systemId: SystemId,
): { combatRound?: number; afbPendingPlayers?: PlayerId[]; pendingHits: Record<string, number> } {
  const afbEligible = getAntiFighterBarrageParticipants(state, rules, systemId);
  if (afbEligible.length === 0) {
    return { combatRound: 1, pendingHits: {} };
  }
  return { afbPendingPlayers: afbEligible, pendingHits: {} };
}

export function useAntiFighterBarrage(
  state: GameState,
  action: { type: "USE_ANTI_FIGHTER_BARRAGE"; playerId: PlayerId; diceRolls: number[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") {
    return { ok: false, error: "RR 67.1: not currently in space combat." };
  }
  const afbPending = pending.afbPendingPlayers ?? [];
  if (!afbPending.includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Anti-Fighter Barrage roll (already fired, or doesn't qualify)." };
  }
  if (Object.keys(pending.pendingHits ?? {}).length > 0) {
    return { ok: false, error: "RR 67.1: resolve the previous combatant's AFB hits before the next one fires." };
  }

  const entries = buildAntiFighterBarrageEntries(state, rules, action.playerId, pending.systemId);
  if (entries.length === 0) return { ok: false, error: "This player has no AFB-capable ships." };

  let result;
  try {
    result = resolveCombatRound(entries, action.diceRolls);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const hits = result.hitsScoredByPlayer[action.playerId] ?? 0;

  const combatants = playersWithShipsInSystem(state, pending.systemId);
  const opponentId = combatants.find((id) => id !== action.playerId) ?? null;
  const remainingAfbPending = afbPending.filter((id) => id !== action.playerId);
  const events: GameEvent[] = [{ type: "ANTI_FIGHTER_BARRAGE_FIRED", playerId: action.playerId, systemId: pending.systemId, hits }];

  let nextState: GameState = {
    ...state,
    pendingTacticalAction: {
      ...pending,
      afbPendingPlayers: remainingAfbPending,
      pendingHits: hits > 0 && opponentId ? { [opponentId]: hits } : {},
    },
  };

  if (hits === 0 && remainingAfbPending.length === 0) {
    nextState = beginCombatRoundsAfterAFB(nextState);
  }

  return { ok: true, state: nextState, events };
}

export function assignAntiFighterBarrageHits(
  state: GameState,
  action: { type: "ASSIGN_ANTI_FIGHTER_BARRAGE_HITS"; playerId: PlayerId; assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") {
    return { ok: false, error: "RR 67.1: not currently in space combat." };
  }
  const hitsOwed = pending.pendingHits?.[action.playerId];
  if (!hitsOwed || hitsOwed <= 0) {
    return { ok: false, error: "This player has no pending Anti-Fighter Barrage hits to assign." };
  }
  if (action.assignments.some((a) => a.unitType !== "fighter")) {
    return { ok: false, error: "RR 67.1: Anti-Fighter Barrage can only hit fighters." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const player = state.players[action.playerId];
  const stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []) as UnitStack[];

  const result = applyHitAssignments(stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR 67.1: ${result.error}` };

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

  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits },
  };

  const afbPending = pending.afbPendingPlayers ?? [];
  if (afbPending.length === 0 && Object.keys(remainingPendingHits).length === 0) {
    nextState = beginCombatRoundsAfterAFB(nextState);
  }

  return { ok: true, state: nextState, events };
}

function beginCombatRoundsAfterAFB(state: GameState): GameState {
  const pending = state.pendingTacticalAction!;
  return { ...state, pendingTacticalAction: { ...pending, combatRound: 1, afbPendingPlayers: undefined } };
}

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

  // RR 67.4's base rule: the destination must be a system the retreating
  // player already has units in, or controls a planet in — UNLESS they own
  // Dark Energy Tap, which specifically waives this (RR: "your ships can
  // retreat into adjacent systems that do not contain other players' units,
  // even if you do not have units or control planets in that system").
  if (!state.players[action.playerId]?.technologies.includes(asTechId("dark_energy_tap"))) {
    const destSystem = state.systems[action.toSystemId];
    const alreadyHasPresence =
      (destSystem?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0) ||
      (destSystem?.planets ?? []).some(
        (p) => p.controllerId === action.playerId || (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0),
      );
    if (!alreadyHasPresence) {
      return {
        ok: false,
        error: "RR 67.4: retreat destination must already have this player's units, or a planet they control (Dark Energy Tap waives this).",
      };
    }
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
  if ((pending.afbPendingPlayers ?? []).length > 0) {
    return { ok: false, error: "RR 67.1: resolve Anti-Fighter Barrage before rolling normal combat dice." };
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

  // RR "Duranium Armor": the player's OWN choice, made right after they
  // assign this round's hits — repair (un-flip) 1 unit that has Sustain
  // Damage AND was ALREADY damaged BEFORE this round's hits were assigned
  // (checked against `stacks`, the pre-assignment snapshot — a unit that
  // just got flipped damaged by this very round's hits doesn't qualify).
  // Which unit (if more than one qualifies) is the player's call, not
  // automatic — see useDuraniumArmor/skipDuraniumArmor below. The round
  // can't wrap up until every such decision (and every pendingHits entry)
  // is resolved.
  const eligibleForDuraniumArmor =
    player.technologies.includes(asTechId("duranium_armor")) &&
    stacks.some((s) => s.damagedCount > 0 && (getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades)?.abilities.includes("sustainDamage") ?? false));

  const duraniumArmorPendingPlayers = eligibleForDuraniumArmor
    ? [...(pending.duraniumArmorPendingPlayers ?? []), action.playerId]
    : pending.duraniumArmorPendingPlayers;

  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    // RR "Self-Assembly Routines": normally mechs never appear in space
    // combat (they're ground forces), but some factions have abilities
    // that let their mechs participate there too — this stays wired in
    // rather than assuming it can never trigger.
    players: { ...state.players, [action.playerId]: applySelfAssemblyRoutinesMechBonus(player, result.destroyed) },
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits, duraniumArmorPendingPlayers },
  };

  if (Object.keys(remainingPendingHits).length === 0 && (duraniumArmorPendingPlayers ?? []).length === 0) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }

  return { ok: true, state: nextState, events };
}

export function useDuraniumArmor(
  state: GameState,
  action: { type: "USE_DURANIUM_ARMOR"; playerId: PlayerId; unitType: UnitType },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") {
    return { ok: false, error: "RR: not currently in space combat." };
  }
  if (!pending.duraniumArmorPendingPlayers?.includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Duranium Armor decision right now." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const player = state.players[action.playerId];
  const stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []) as UnitStack[];
  const stack = stacks.find((s) => s.unitType === action.unitType);
  if (!stack || stack.damagedCount <= 0) {
    return { ok: false, error: `No damaged ${action.unitType} to repair.` };
  }
  const unitStats = getUnitStats(rules, player.factionId, action.unitType, player.unitUpgrades);
  if (!unitStats?.abilities.includes("sustainDamage")) {
    return { ok: false, error: `RR 76: ${action.unitType} doesn't have Sustain Damage.` };
  }

  const updatedStacks = stacks.map((s) => (s.unitType === action.unitType ? { ...s, damagedCount: s.damagedCount - 1 } : s));
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };
  const remainingPending = pending.duraniumArmorPendingPlayers.filter((id) => id !== action.playerId);

  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    pendingTacticalAction: { ...pending, duraniumArmorPendingPlayers: remainingPending },
  };
  const events: GameEvent[] = [{ type: "UNIT_REPAIRED", playerId: action.playerId, systemId, unitType: action.unitType, count: 1 }];

  if (Object.keys(nextState.pendingTacticalAction!.pendingHits ?? {}).length === 0 && remainingPending.length === 0) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }
  return { ok: true, state: nextState, events };
}

export function skipDuraniumArmor(
  state: GameState,
  action: { type: "SKIP_DURANIUM_ARMOR"; playerId: PlayerId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") {
    return { ok: false, error: "RR: not currently in space combat." };
  }
  if (!pending.duraniumArmorPendingPlayers?.includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Duranium Armor decision right now." };
  }

  const remainingPending = pending.duraniumArmorPendingPlayers.filter((id) => id !== action.playerId);
  let nextState: GameState = { ...state, pendingTacticalAction: { ...pending, duraniumArmorPendingPlayers: remainingPending } };

  if (Object.keys(pending.pendingHits ?? {}).length === 0 && remainingPending.length === 0) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: wrap.events };
  }
  return { ok: true, state: nextState, events: [] };
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

  // Both sides still standing — next round, no retreat option in ground combat (RR 38).
  nextState = {
    ...nextState,
    pendingTacticalAction: { ...pending, combatRound: (pending.combatRound ?? 1) + 1, pendingHits: {}, retreating: [] },
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
