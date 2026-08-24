import { GameState, PendingTacticalAction, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, asTechId, NEUTRAL_PLAYER_ID } from "../types/ids";
import { UnitType, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { isAdjacent, maybeActivateWormholeNexus } from "../rules/adjacency";
import { canShipEnterTile, hasEntropicScar } from "../rules/anomalies";
import { getEffectiveUnitAbilities } from "./agendaEffects";
import { maybeQueueCrownOfThalnosReroll } from "../rules/relics";
import {
  playersWithShipsInSystem,
  buildSpaceCombatEntries,
  resolveCombatRound,
  applyHitAssignments,
  computeNeutralHitAssignments,
  applySelfAssemblyRoutinesMechBonus,
  getAntiFighterBarrageParticipants,
  buildAntiFighterBarrageEntries,
} from "../rules/combat";
import { actionPhaseWindowOrder } from "../rules/priorityWindow";
import { resolveSpaceStationControl } from "../rules/spaceStations";
import { openInvasionStartWindowIfNeeded } from "./invasion";
import { maybeDestroyBlockadedFloatingFactories } from "../rules/saar";

/** Called at every point in this file where pendingTacticalAction might have JUST landed on a genuine "a combat round begins now" state (round 1 after Assault Cannon/AFB have both already resolved or never triggered at all, OR round N+1 right after the previous round wrapped up) — opens the RR 1.19 "combat_round_start" priority window (see rules/priorityWindow.ts) for the (exactly 2, per this project's own combat-participant limitation) combatants, active-player-first. A safe no-op if we're not actually at a fresh round start yet (still mid-AFB/Assault-Cannon, or combat already ended and moved to "invasion"), or if a window is somehow already open. */
/** RR "Salvage": opens a single-participant window for the winner right as space combat concludes — chains into openInvasionStartWindowIfNeeded once closed (GameEngine.ts's own window-close handling), same "after you win" before "at the start of an invasion" ordering RR 1.16 implies. */
export function openSpaceCombatWonWindowIfNeeded(state: GameState, winnerId: PlayerId): GameState {
  if (state.pendingPriorityWindow || state.players[winnerId]?.eliminated) return state;
  return { ...state, pendingPriorityWindow: { kind: "space_combat_won", order: [winnerId], currentIndex: 0, consecutivePasses: 0 } };
}

export function openCombatRoundStartWindowIfNeeded(state: GameState): GameState {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat" || pending.combatRound === undefined) return state;

  // Letnev "Arc Secundus" (flagship, Auto-Repair): "At the start of each
  // space combat round, repair this ship." Confirmed (yjmrobert.com/tirules/factions/f_letnev):
  // mandatory, automatic (not a player choice) — "only uses its repair
  // ability during combats it is participating in" (checked via presence
  // in THIS system specifically) and "not repaired at the end of combat"
  // (this hook only ever fires at a round's own START, never at the end).
  let nextState = state;
  for (const [ownerId, stacks] of Object.entries(state.systems[pending.systemId]?.spaceUnitsByPlayer ?? {})) {
    const flagshipStack = (stacks ?? []).find((s) => s.unitType === "flagship" && s.count > 0);
    if (!flagshipStack || flagshipStack.damagedCount <= 0) continue;
    const owner = state.players[ownerId as PlayerId];
    if (owner?.factionId !== ("letnev" as never)) continue;
    const updatedStacks = (stacks ?? []).map((s) => (s === flagshipStack ? { ...s, damagedCount: 0 } : s));
    nextState = {
      ...nextState,
      systems: { ...nextState.systems, [pending.systemId]: { ...nextState.systems[pending.systemId], spaceUnitsByPlayer: { ...nextState.systems[pending.systemId].spaceUnitsByPlayer, [ownerId]: updatedStacks } } },
    };
  }

  // Only Assault Cannon (mandatory, not a "wish to resolve" ability — see
  // its own doc comment above) gates this; AFB no longer does — RR: round
  // 1's "start of combat"/"start of combat round" window is BEFORE AFB,
  // so `afbPendingPlayers` being populated at the same time `combatRound`
  // is set is the NORMAL case this should still open for, not skip.
  if (pending.assaultCannonPendingPlayer) return nextState;
  if (nextState.pendingPriorityWindow) return nextState;
  const participants = playersWithShipsInSystem(nextState, pending.systemId);
  const order = actionPhaseWindowOrder(nextState, pending.playerId, participants);
  if (order.length === 0) return nextState;
  return { ...nextState, pendingPriorityWindow: { kind: "combat_round_start", order, currentIndex: 0, consecutivePasses: 0 } };
}

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
 * RR (yjmrobert.com/tirules/rules/r_space_combat): "before combat" occurs
 * immediately before Anti-Fighter Barrage, and "start of combat"/"start of
 * combat round" are the SAME window during round 1 — so the
 * combat_round_start priority window (rules/priorityWindow.ts) for round 1
 * opens BEFORE AFB is even offered, not after (useAntiFighterBarrage below
 * is gated on that window having fully closed first). AFB itself doesn't
 * compete for that window at all — it's each side using their OWN units'
 * ability, simultaneously, not a contested/priority-ordered choice.
 *
 * NOT implemented yet, flagged rather than silently skipped:
 *  - A card/ability granting an AFB roll to a unit that doesn't actually
 *    have the ability — same category of gap as PLAY_ACTION_CARD not
 *    existing yet.
 *  - 3+ players' ships in one combat (buildSpaceCombatEntries already
 *    throws rather than guess which 2 fight first).
 *
 * CORRECTED (this comment was stale): "capacity overflow" — if combat
 * destroys a ship that was carrying fighters/ground forces, leaving the
 * survivor's own combined capacity short — IS handled, via this file's
 * own computeCapacityOverflow/pendingCapacityOverflow (see
 * wrapUpCombatRound below). Scoped to once combat fully CONCLUDES
 * (survivors.length <= 1), not re-checked after every individual round —
 * nothing else a player could do mid-combat is actually affected by a
 * temporary over-capacity state between rounds, so this is a deliberate,
 * reasonable simplification rather than a gap.
 */

/**
 * Called whenever a tactical action's pendingTacticalAction is about to
 * become step "spaceCombat", from wherever that transition happens — so
 * AFB eligibility (and, before it, Assault Cannon's own trigger — see
 * below) is computed exactly once, consistently, regardless of which step
 * led here.
 */
export function computeSpaceCombatEntry(
  state: GameState,
  rules: RuleData,
  systemId: SystemId,
  attackerId: PlayerId,
): { combatRound?: number; afbPendingPlayers?: PlayerId[]; assaultCannonPendingPlayer?: PlayerId; assaultCannonStage?: "attacker" | "defender"; pendingHits: Record<string, number> } {
  const defenderId = playersWithShipsInSystem(state, systemId).find((id) => id !== attackerId);
  if (defenderId) {
    // RR "Assault Cannon": resolution order is confirmed — the ACTIVE
    // player's own trigger (if any) resolves FIRST, forcing the defender
    // to destroy one of THEIR non-fighter ships; only THEN is the
    // defender's own trigger checked, against the now-possibly-reduced
    // ship count (see resolveAssaultCannonStage for the "attacker" ->
    // "defender" continuation once this first stage resolves).
    const attackerTrigger = checkAssaultCannonTrigger(state, rules, systemId, attackerId, defenderId);
    if (attackerTrigger) {
      return { assaultCannonPendingPlayer: defenderId, assaultCannonStage: "attacker", pendingHits: {} };
    }
    const defenderTrigger = checkAssaultCannonTrigger(state, rules, systemId, defenderId, attackerId);
    if (defenderTrigger) {
      return { assaultCannonPendingPlayer: attackerId, assaultCannonStage: "defender", pendingHits: {} };
    }
  }

  return computeAfbEntry(state, rules, systemId);
}

/** RR "Assault Cannon": does `triggeringPlayerId` currently have 3+ non-fighter ships AND own the tech, with `opponentId` actually having a non-fighter ship to lose? (No-op — doesn't trigger — if the opponent has none left to destroy.) */
function checkAssaultCannonTrigger(state: GameState, rules: RuleData, systemId: SystemId, triggeringPlayerId: PlayerId, opponentId: PlayerId): boolean {
  const player = state.players[triggeringPlayerId];
  if (!player.technologies.includes(asTechId("assault_cannon"))) return false;
  const ownStacks = (state.systems[systemId]?.spaceUnitsByPlayer[triggeringPlayerId] ?? []) as UnitStack[];
  const ownNonFighterCount = ownStacks.filter((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter").reduce((sum, s) => sum + s.count, 0);
  if (ownNonFighterCount < 3) return false;
  const opponentStacks = (state.systems[systemId]?.spaceUnitsByPlayer[opponentId] ?? []) as UnitStack[];
  return opponentStacks.some((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter" && s.count > 0);
}

/** RR (yjmrobert.com/tirules/rules/r_space_combat): "before combat" occurs immediately before Anti-Fighter Barrage, and during round 1, "start of combat" and "start of combat round" are the SAME window — so `combatRound` is set to 1 (and the combat_round_start priority window opened, by this function's own callers) BEFORE AFB eligibility is even checked, not after. AFB itself doesn't compete for that window at all — RR: "the players MAY SIMULTANEOUSLY use [AFB]", not a priority-ordered choice — it's simply gated (see useAntiFighterBarrage/skipAntiFighterBarrage) on that window having fully closed first. */
function computeAfbEntry(
  state: GameState,
  rules: RuleData,
  systemId: SystemId,
): { combatRound: number; afbPendingPlayers?: PlayerId[]; pendingHits: Record<string, number> } {
  const afbEligible = getAntiFighterBarrageParticipants(state, rules, systemId);
  if (afbEligible.length === 0) {
    return { combatRound: 1, pendingHits: {} };
  }
  return { combatRound: 1, afbPendingPlayers: afbEligible, pendingHits: {} };
}

/** RR "Assault Cannon": the mandatory (no skip — see this project's own note on why) destruction the triggered player owes. They choose WHICH of their own non-fighter ships to destroy, same "real choice, not engine-picked" pattern as everywhere else in this codebase. Once resolved, if this was the ATTACKER's trigger (stage "attacker"), the DEFENDER's own trigger is checked next against the now-current ship count — continuing the confirmed resolution order — before finally moving on to AFB/combat rounds. */
export function useAssaultCannonDestruction(
  state: GameState,
  action: { type: "USE_ASSAULT_CANNON_DESTRUCTION"; playerId: PlayerId; unitType: UnitType },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") {
    return { ok: false, error: "RR: not currently in space combat." };
  }
  if (pending.assaultCannonPendingPlayer !== action.playerId) {
    return { ok: false, error: "This player has no pending Assault Cannon destruction owed right now." };
  }
  if (!SHIP_TYPES.includes(action.unitType) || action.unitType === "fighter") {
    return { ok: false, error: 'RR "Assault Cannon": must destroy a non-fighter ship.' };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []) as UnitStack[];
  const stack = stacks.find((s) => s.unitType === action.unitType);
  if (!stack || stack.count <= 0) return { ok: false, error: `This player has no ${action.unitType} to destroy.` };

  const updatedStacks = stacks.map((s) => (s.unitType === action.unitType ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };
  const events: GameEvent[] = [{ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, unitType: action.unitType, count: 1 }];

  let nextState: GameState = { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
  const attackerId = pending.playerId;
  const defenderId = playersWithShipsInSystem(nextState, systemId).find((id) => id !== attackerId);

  if (pending.assaultCannonStage === "attacker" && defenderId) {
    // The attacker's own trigger just resolved (this destruction was the
    // DEFENDER's own ship) — now check the DEFENDER's trigger, against
    // the just-updated ship count, per the confirmed resolution order.
    const defenderTrigger = checkAssaultCannonTrigger(nextState, rules, systemId, defenderId, attackerId);
    nextState = {
      ...nextState,
      pendingTacticalAction: defenderTrigger
        ? { ...pending, assaultCannonPendingPlayer: attackerId, assaultCannonStage: "defender" }
        : { ...pending, assaultCannonPendingPlayer: undefined, assaultCannonStage: undefined, ...computeAfbEntry(nextState, rules, systemId) },
    };
    return { ok: true, state: openCombatRoundStartWindowIfNeeded(nextState), events };
  }

  // Either this was the "defender" stage (last one — nothing more to check), or there's no defender left at all (combat's about to end anyway).
  nextState = {
    ...nextState,
    pendingTacticalAction: { ...pending, assaultCannonPendingPlayer: undefined, assaultCannonStage: undefined, ...computeAfbEntry(nextState, rules, systemId) },
  };
  return { ok: true, state: openCombatRoundStartWindowIfNeeded(nextState), events };
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
  if (state.pendingPriorityWindow?.kind === "combat_round_start") {
    return { ok: false, error: "RR 1.19/1.20: every player must be given (and decline) their chance to play a start-of-combat card before Anti-Fighter Barrage." };
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
    const wrap = beginCombatRoundsAfterAFB(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
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
  // RR "Waylay": if the OPPOSING player (whoever dealt these hits) played it, AFB hits can target any ship here, not just fighters.
  const waylayActive = pending.waylayPlayerId !== undefined && pending.waylayPlayerId !== action.playerId;
  if (!waylayActive && action.assignments.some((a) => a.unitType !== "fighter")) {
    return { ok: false, error: "RR 67.1: Anti-Fighter Barrage can only hit fighters." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const player = state.players[action.playerId];
  const stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []) as UnitStack[];

  // TE NEUTRAL UNITS: same fixed-priority-order reasoning as everywhere else this project computes hit assignments for the neutral pseudo-player.
  const afbAssignments = action.playerId === NEUTRAL_PLAYER_ID ? computeNeutralHitAssignments(stacks, hitsOwed, hasEntropicScar(system.anomalies)) : action.assignments;

  const result = applyHitAssignments(state, stacks, afbAssignments, hitsOwed, player.factionId, player.unitUpgrades, rules, system.anomalies);
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
    const wrap = beginCombatRoundsAfterAFB(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }

  return { ok: true, state: nextState, events };
}

/**
 * RR 67.1/78.3a: if AFB wipes out one (or both) side's ships entirely,
 * space combat ends IMMEDIATELY right here — it never even reaches a
 * normal combat round.
 *
 * combatRound is ALREADY 1 by the time this runs (set by computeAfbEntry,
 * before AFB even started — see this file's own header comment on why
 * "start of combat"/"start of combat round 1" has to precede AFB, not
 * follow it), so if combat continues past AFB, there's nothing left to
 * open or set here beyond clearing the resolved afbPendingPlayers marker.
 */
function beginCombatRoundsAfterAFB(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingTacticalAction!;
  const systemId = pending.systemId;
  const combatantsBeforeEnd = Object.keys(state.systems[systemId]?.spaceUnitsByPlayer ?? {}) as PlayerId[];
  const survivors = playersWithShipsInSystem(state, systemId);

  if (survivors.length <= 1) {
    const winnerId = survivors[0] ?? null;
    let nextState = state;
    nextState = resolveSpaceStationControl(nextState, systemId);
    nextState = { ...nextState, pendingTacticalAction: { playerId: pending.playerId, systemId, step: "invasion" } };
    nextState = winnerId ? openSpaceCombatWonWindowIfNeeded(nextState, winnerId) : openInvasionStartWindowIfNeeded(nextState);
    return { state: nextState, events: [{ type: "SPACE_COMBAT_ENDED", systemId, survivingPlayerId: winnerId }] };
  }

  // combatRound is already 1 from computeAfbEntry, and the round's own
  // combat_round_start window already ran its course BEFORE AFB even
  // began (see this function's own header comment on the reordering) —
  // nothing left to open here, just clear the now-resolved AFB marker.
  return { state: { ...state, pendingTacticalAction: { ...pending, afbPendingPlayers: undefined } }, events: [] };
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
  if (pending.interceptedPlayerId === action.playerId) {
    return { ok: false, error: 'RR "Intercept": this player cannot retreat during this round of space combat.' };
  }
  // RR 67.4/78.4b: if the DEFENDER has already announced a retreat this
  // round, the ATTACKER cannot also announce one — previously unchecked,
  // meaning both sides could retreat from the same combat round.
  const isAttacker = action.playerId === pending.playerId;
  if (isAttacker && (pending.retreating ?? []).some((r) => r.playerId !== pending.playerId)) {
    return { ok: false, error: "RR 67.4: the defender has already announced a retreat this round — the attacker cannot also retreat." };
  }
  if (!isAdjacent(state, pending.systemId, action.toSystemId)) {
    return { ok: false, error: "RR 67.4: retreat destination must be adjacent to the combat system." };
  }
  const blockers = playersWithShipsInSystem(state, action.toSystemId).filter((p) => p !== action.playerId);
  if (blockers.length > 0) {
    return { ok: false, error: "RR 67.4: cannot retreat into a system that contains another player's ships." };
  }

  // RR 11.1/86.1: retreating is still a form of movement — a destination
  // system that's an asteroid field or supernova is off-limits regardless
  // of Dark Energy Tap (which only waives the "already has presence there"
  // requirement below, not anomaly movement rules generally). Previously
  // unchecked entirely.
  const destAnomalies = state.systems[action.toSystemId]?.anomalies ?? [];
  const ignoreAsteroidFields = state.players[action.playerId]?.technologies.includes(asTechId("antimass_deflectors")) ?? false;
  if (!canShipEnterTile(destAnomalies, { isActiveSystem: false, ignoreAsteroidFields })) {
    return { ok: false, error: "RR 11.1/86.1: cannot retreat into that system — it's an asteroid field or supernova." };
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
  action: {
    type: "RESOLVE_COMBAT_ROUND";
    playerId: PlayerId;
    diceRolls: number[];
    viscountUnlennBonus?: { ownerId: PlayerId; targetPlayerId: PlayerId; unitType: UnitType };
    gravleashManeuversUnitType?: UnitType;
    /** Hacan "Wrath of Kenara" (flagship, Trade Good Bonus): "After you roll a die during a space combat in this system, you may spend 1 trade good to apply +1 to the result." Confirmed (tirules2.com/F_hacan): "triggered only once for each die rolled" (can't spend 2+ on a SINGLE die for +2+) — trusted-input convention, same as every other roll in this project: the caller's own diceRolls array above already reflects any +1 boosts applied, and this is simply how many trade goods they're paying for that (1 per boosted die, at most 1 boost per die since there's no mechanism here to apply more). */
    wrathOfKenaraTradeGoodsSpent?: number;
  },
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
  if (state.pendingPriorityWindow?.kind === "combat_round_start") {
    return { ok: false, error: "RR 1.19: every combatant must be given (and decline) their chance to play a round-start card before dice can be rolled." };
  }

  const systemId = pending.systemId;
  const combatants = playersWithShipsInSystem(state, systemId);
  if (!combatants.includes(action.playerId)) {
    return { ok: false, error: "RR 67.5: only a player with ships in this combat can submit its dice roll." };
  }

  // Letnev "Viscount Unlenn" (agent): validated + exhausted here, right before this round's own dice entries get built, since her bonus die needs to already be reflected in them. FIXED: the owner (whoever holds Viscount Unlenn) need NOT be a combatant themselves — only the TARGET (whose unit actually gets the bonus die) must be.
  let workingState = state;
  if (action.viscountUnlennBonus) {
    const unlennOwner = workingState.players[action.viscountUnlennBonus.ownerId];
    const unlennEntry = unlennOwner?.leaders.find((l) => l.leaderId === ("letnev_agent" as never));
    if (!unlennEntry) return { ok: false, error: "That player doesn't have Viscount Unlenn." };
    if (unlennEntry.exhausted) return { ok: false, error: "Viscount Unlenn is already exhausted." };
    if (!combatants.includes(action.viscountUnlennBonus.targetPlayerId)) return { ok: false, error: "That target isn't a combatant in this space combat." };
    workingState = {
      ...workingState,
      players: {
        ...workingState.players,
        [action.viscountUnlennBonus.ownerId]: { ...unlennOwner, leaders: unlennOwner.leaders.map((l) => (l.leaderId === ("letnev_agent" as never) ? { ...l, exhausted: true } : l)) },
      },
    };
  }

  // Hacan "Wrath of Kenara" (flagship, Trade Good Bonus): validated + paid here.
  if (action.wrathOfKenaraTradeGoodsSpent && action.wrathOfKenaraTradeGoodsSpent > 0) {
    const casterPlayer = workingState.players[action.playerId];
    const hasWrathOfKenaraHere = (workingState.systems[systemId]?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "flagship" && s.count > 0) && casterPlayer?.factionId === ("hacan" as never);
    if (!hasWrathOfKenaraHere) return { ok: false, error: "This player doesn't have Wrath of Kenara in this system." };
    if (casterPlayer.tradeGoods < action.wrathOfKenaraTradeGoodsSpent) return { ok: false, error: "Not enough trade goods." };
    workingState = { ...workingState, players: { ...workingState.players, [action.playerId]: { ...casterPlayer, tradeGoods: casterPlayer.tradeGoods - action.wrathOfKenaraTradeGoodsSpent } } };
  }

  let entries;
  try {
    let gravleashManeuversBonus: { playerId: PlayerId; unitType: UnitType; bonusPerDie: number } | undefined;
    if (action.gravleashManeuversUnitType) {
      const casterPlayer = workingState.players[action.playerId];
      if (!casterPlayer?.hasBreakthrough || casterPlayer.factionId !== ("letnev" as never)) {
        return { ok: false, error: "This player doesn't have Gravleash Maneuvers." };
      }
      // Letnev "Gravleash Maneuvers": "X is the number of ship types you have in the combat" — every DISTINCT ship type this player has present in this system, regardless of whether that type even rolls dice (e.g. a space dock isn't a ship at all and wouldn't count, but every SHIP type present, including fighters, does).
      const distinctShipTypes = new Set((workingState.systems[systemId]?.spaceUnitsByPlayer[action.playerId] ?? []).filter((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0).map((s) => s.unitType));
      gravleashManeuversBonus = { playerId: action.playerId, unitType: action.gravleashManeuversUnitType, bonusPerDie: distinctShipTypes.size };
    }
    entries = buildSpaceCombatEntries(
      workingState,
      rules,
      systemId,
      pending.playerId,
      action.viscountUnlennBonus && { targetPlayerId: action.viscountUnlennBonus.targetPlayerId, unitType: action.viscountUnlennBonus.unitType },
      gravleashManeuversBonus,
    );
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
  const updatedPending = maybeQueueCrownOfThalnosReroll(workingState, { ...pending, combatRound: round, pendingHits }, result.missedDiceByPlayerAndType);
  // Letnev "Munitions Reserves": the same missed-dice data Crown of Thalnos just used above, stashed here too so useMunitionsReserves (rules/letnev.ts) has something to check against — gating (Letnev ownership, cost, once-per-round) happens over there, not here.
  let nextState: GameState = { ...workingState, pendingTacticalAction: { ...updatedPending, munitionsReservesMissedDiceByPlayer: result.missedDiceByPlayerAndType } };

  const events: GameEvent[] = [
    { type: "COMBAT_ROUND_RESOLVED", systemId, round, hitsScoredByPlayer: result.hitsScoredByPlayer },
  ];

  // Nobody hit anything, and no Crown of Thalnos reroll decision is
  // pending either — nothing to assign, go straight to end-of-round checks.
  if (Object.keys(pendingHits).length === 0 && (nextState.pendingTacticalAction?.crownOfThalnosPendingPlayers ?? []).length === 0) {
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

  // TE NEUTRAL UNITS: see phases/invasion.ts's own assignGroundCombatHits for the identical fixed-priority-order reasoning — same mechanic, space combat side.
  const spaceAssignments = action.playerId === NEUTRAL_PLAYER_ID ? computeNeutralHitAssignments(stacks, hitsOwed, hasEntropicScar(system.anomalies)) : action.assignments;

  // L1Z1X "Priority Targeting" (flagship ability): true if this player's own opponent in this combat is L1Z1X and has their flagship or a dreadnought present here — see combat.ts's own applyHitAssignments for the full doc comment on this parameter's own known scope limit.
  const opponentId = Object.keys(system.spaceUnitsByPlayer).find((id) => id !== action.playerId && (system.spaceUnitsByPlayer[id as PlayerId] ?? []).some((s) => s.count > 0)) as PlayerId | undefined;
  const opponentPlayer = opponentId ? state.players[opponentId] : undefined;
  const mustPreferNonFighterTargets =
    opponentPlayer?.factionId === ("l1z1x" as never) &&
    (system.spaceUnitsByPlayer[opponentId!] ?? []).some((s) => (s.unitType === "flagship" || s.unitType === "dreadnought") && s.count > 0);

  const result = applyHitAssignments(state, stacks, spaceAssignments, hitsOwed, player.factionId, player.unitUpgrades, rules, system.anomalies, player.relics.includes("metali_void_shielding" as never), player.technologies.includes("non_euclidean_shielding" as never), mustPreferNonFighterTargets);
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
    stacks.some((s) => s.damagedCount > 0 && getEffectiveUnitAbilities(state, rules, player.factionId, s.unitType, player.unitUpgrades).includes("sustainDamage"));

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

  // TE "Crash Landing": "When your last ship in the active system is
  // destroyed" — checked right here, the one place a player's own ships
  // in a system actually go from >0 to 0. Only offered if they actually
  // have ground forces sitting in that system's space area (transported
  // units) to place — nothing to react with otherwise.
  const shipsLeft = (updatedSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  const groundForcesInSpace = (updatedSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => GROUND_FORCE_TYPES.includes(s.unitType) && s.count > 0);
  if (!shipsLeft && groundForcesInSpace && !nextState.pendingPriorityWindow) {
    nextState = { ...nextState, pendingPriorityWindow: { kind: "last_ship_destroyed", order: [action.playerId], currentIndex: 0, consecutivePasses: 0 } };
  }

  if (Object.keys(remainingPendingHits).length === 0 && (duraniumArmorPendingPlayers ?? []).length === 0 && (pending.crownOfThalnosPendingPlayers ?? []).length === 0) {
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
  const effectiveAbilities = getEffectiveUnitAbilities(state, rules, player.factionId, action.unitType, player.unitUpgrades);
  if (!effectiveAbilities.includes("sustainDamage")) {
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

  if (Object.keys(nextState.pendingTacticalAction!.pendingHits ?? {}).length === 0 && remainingPending.length === 0 && (nextState.pendingTacticalAction!.crownOfThalnosPendingPlayers ?? []).length === 0) {
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

  if (Object.keys(pending.pendingHits ?? {}).length === 0 && remainingPending.length === 0 && (pending.crownOfThalnosPendingPlayers ?? []).length === 0) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: wrap.events };
  }
  return { ok: true, state: nextState, events: [] };
}

// --- helpers ---------------------------------------------------------------

/** Called once every player owed hits this round has submitted ASSIGN_HITS. Executes any announced retreats, then either ends space combat (advances to "invasion") or starts the next round. */
function wrapUpCombatRound(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingTacticalAction;
  if (!pending) return { state, events: [] };
  const systemId = pending.systemId;
  const events: GameEvent[] = [];

  // Clan of Saar "Floating Factory": confirmed
  // (yjmrobert.com/tirules/factions/f_saar) — "If the Saar player
  // announces a retreat during a space combat, but all their ships are
  // destroyed that round, any Floating Factories in that system are
  // destroyed without retreating" and "if, at the end of combat, the
  // Saar player has no ships... Floating Factories in the system will be
  // blockaded, and thus destroyed, before the fighters are removed due
  // to lack of capacity." Checked here, BEFORE the retreat loop below —
  // this round's hits were already assigned before this function runs,
  // so if the Saar player is down to 0 real ships here (their Floating
  // Factory, if any, is now blockaded by isBlockaded's own "0 own ships,
  // 1+ enemy ships" definition), it's destroyed immediately, and the
  // retreat loop's own "stillHasShips" check right below naturally sees
  // it gone — matching "destroyed without retreating" instead of moving
  // along with a retreat. "If neither player has ships... the Floating
  // Factory is not destroyed" is already correctly handled for free by
  // isBlockaded's own definition (requires the OTHER player to still
  // have ships present). NOT specifically handled: the Direct Hit
  // sustain-damage-sequencing nuance, and Nekro's own Alastor
  // ground-forces-as-ships edge case — both flagged rather than silently
  // assumed correct, given how narrow and combat-engine-specific they are.
  let nextState = maybeDestroyBlockadedFloatingFactories(state);
  for (const r of pending.retreating ?? []) {
    const stillHasShips = (nextState.systems[systemId].spaceUnitsByPlayer[r.playerId] ?? []).length > 0;
    if (!stillHasShips) continue; // wiped out this round before retreating
    const retreatResult = moveAllShips(nextState, systemId, r.toSystemId, r.playerId, rules);
    nextState = retreatResult.state;
    events.push(...retreatResult.events);
    // RR 100.2: ships retreating INTO the wormhole nexus system also flip it active.
    nextState = maybeActivateWormholeNexus(nextState, rules, r.toSystemId);
  }

  // Object.keys here (not playersWithShipsInSystem) on purpose — a
  // combatant wiped out to 0 ships this round still has their (now empty)
  // stacks entry in spaceUnitsByPlayer, so this is the only reliable way
  // to recover "who was actually fighting here" for RR "Shard of the
  // Throne"'s own check below, once one side has been fully eliminated.
  const combatantsBeforeEnd = Object.keys(state.systems[systemId]?.spaceUnitsByPlayer ?? {}) as PlayerId[];
  const survivors = playersWithShipsInSystem(nextState, systemId);

  if (survivors.length <= 1) {
    const winnerId = survivors[0] ?? null;
    nextState = resolveSpaceStationControl(nextState, systemId);

    // RR 16.3/78.10a: the winner's own surviving ships might have less
    // combined capacity now than before this combat (some destroyed),
    // potentially leaving their fighters/ground forces here over that
    // now-reduced capacity — queues their own choice of what to remove
    // instead of transitioning straight to "invasion".
    const overflow = winnerId ? computeCapacityOverflow(nextState, rules, systemId, winnerId) : 0;
    nextState = {
      ...nextState,
      pendingTacticalAction:
        winnerId && overflow > 0
          ? { playerId: pending.playerId, systemId, step: "spaceCombat", pendingCapacityOverflow: { playerId: winnerId, excessCount: overflow } }
          : { playerId: pending.playerId, systemId, step: "invasion" },
    };
    nextState = winnerId && overflow === 0 ? openSpaceCombatWonWindowIfNeeded(nextState, winnerId) : openInvasionStartWindowIfNeeded(nextState);
    events.push({ type: "SPACE_COMBAT_ENDED", systemId, survivingPlayerId: winnerId });
    return { state: nextState, events };
  }

  nextState = {
    ...nextState,
    pendingTacticalAction: {
      ...pending,
      combatRound: (pending.combatRound ?? 1) + 1,
      pendingHits: {},
      retreating: [],
      // RR "Intercept" (yjmrobert.com/tirules/components/c_action_cards): "During the NEXT round of combat, the targeted player may declare another retreat" — the block is scoped to the round it was played in, not the rest of combat.
      interceptedPlayerId: undefined,
      // Letnev "Munitions Reserves": "may only be triggered once per round" — resets each new round, same pattern as Dunlain Reaper Deploy's own once-per-round flag.
      usedMunitionsReservesThisRound: false,
      // Letnev "War Funding"/"War Funding Ω": same "not again until the next round of combat" reset.
      usedWarFundingThisRoundBy: undefined,
    },
  };
  return { state: openCombatRoundStartWindowIfNeeded(nextState), events };
}

/**
 * RR 67.7/78.7b: a retreating player takes all of their ships WITH a move
 * value — fighters and ground forces don't retreat under their own power
 * here, they need to be carried by those ships' own combined capacity,
 * same as any other transport. Whichever fighters/ground forces don't
 * fit (or whichever ship, unusually, has no move value at all) are
 * "unable to move or be transported" and are removed outright — this was
 * previously unchecked entirely; every retreating unit just moved along
 * regardless of capacity. Which specific units get left behind when
 * capacity falls short isn't offered as a real player choice yet (stack
 * order instead) — flagged simplification, same category as this
 * project's other minor "which unit" defaults.
 */
export function moveAllShips(state: GameState, fromSystemId: SystemId, toSystemId: SystemId, playerId: PlayerId, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const fromSystem = state.systems[fromSystemId];
  const toSystem = state.systems[toSystemId];
  const player = state.players[playerId];
  const allStacks = fromSystem.spaceUnitsByPlayer[playerId] ?? [];

  const retreatingShips: UnitStack[] = [];
  const cargoStacks: UnitStack[] = [];
  let totalCapacity = 0;

  for (const stack of allStacks) {
    if (stack.count <= 0) continue;
    if (stack.unitType === "fighter" || GROUND_FORCE_TYPES.includes(stack.unitType)) {
      cargoStacks.push(stack);
      continue;
    }
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    if (stats?.move == null) continue; // no move value — stays behind, removed below
    retreatingShips.push(stack);
    totalCapacity += (stats.capacity ?? 0) * stack.count;
  }

  let remainingCapacity = totalCapacity;
  const movingCargo: UnitStack[] = [];
  const events: GameEvent[] = [];
  for (const stack of cargoStacks) {
    const carried = Math.min(remainingCapacity, stack.count);
    if (carried > 0) movingCargo.push({ ...stack, count: carried, damagedCount: Math.min(stack.damagedCount, carried) });
    remainingCapacity -= carried;
    const leftBehind = stack.count - carried;
    if (leftBehind > 0) {
      events.push({ type: "UNITS_DESTROYED", playerId, systemId: fromSystemId, unitType: stack.unitType, count: leftBehind });
    }
  }

  const movingStacks = [...retreatingShips, ...movingCargo];
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

  let nextState: GameState = { ...state, systems: { ...state.systems, [fromSystemId]: updatedFrom, [toSystemId]: updatedTo } };

  // RR 67.4/78.7d: a player whose units successfully retreat into an
  // adjacent system must place a command token from their reinforcements
  // there — unless they already have one in that system, in which case
  // this is simply a no-op (not an additional token). Previously
  // unchecked entirely. A no-op if nothing actually retreated (e.g. every
  // ship had no move value and was left behind).
  if (movingStacks.length > 0 && !player.commandTokens.onBoard.includes(toSystemId)) {
    nextState = {
      ...nextState,
      players: { ...nextState.players, [playerId]: { ...player, commandTokens: { ...player.commandTokens, onBoard: [...player.commandTokens.onBoard, toSystemId] } } },
    };
  }

  // TE SPACE STATIONS: same sole-ship-owner control check as normal
  // movement — this function is used for retreats and Ghost-Ship-style
  // effects, which can just as easily leave a system down to 1 owner.
  nextState = resolveSpaceStationControl(nextState, fromSystemId);
  nextState = resolveSpaceStationControl(nextState, toSystemId);

  return { state: nextState, events };
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

/** RR 16.3: how many of the winner's own fighters + ground forces in this system's space area exceed the combined capacity of their OWN surviving ships there — 0 if within limits. */
function computeCapacityOverflow(state: GameState, rules: RuleData, systemId: SystemId, playerId: PlayerId): number {
  const player = state.players[playerId];
  const stacks = (state.systems[systemId]?.spaceUnitsByPlayer[playerId] ?? []) as UnitStack[];
  let capacity = 0;
  let cargo = 0;
  for (const stack of stacks) {
    if (stack.count <= 0) continue;
    if (stack.unitType === "fighter" || GROUND_FORCE_TYPES.includes(stack.unitType)) {
      cargo += stack.count;
      continue;
    }
    if (!SHIP_TYPES.includes(stack.unitType)) continue;
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    capacity += (stats?.capacity ?? 0) * stack.count;
  }
  return Math.max(0, cargo - capacity);
}

/** RR 16.3/78.10a: the winner's own choice of which excess fighters/ground forces to remove, now that their surviving ships' combined capacity can't hold them all. */
export function removeExcessCapacityUnits(
  state: GameState,
  action: { type: "REMOVE_EXCESS_CAPACITY_UNITS"; playerId: PlayerId; removals: { unitType: UnitType; count: number }[] },
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending?.pendingCapacityOverflow || pending.pendingCapacityOverflow.playerId !== action.playerId) {
    return { ok: false, error: "This player has no pending excess-capacity removal owed right now." };
  }
  const totalRemoved = action.removals.reduce((sum, r) => sum + r.count, 0);
  if (totalRemoved !== pending.pendingCapacityOverflow.excessCount) {
    return { ok: false, error: `RR 16.3: must remove exactly ${pending.pendingCapacityOverflow.excessCount} excess unit(s), not ${totalRemoved}.` };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  let stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  for (const { unitType, count } of action.removals) {
    if (count <= 0) continue;
    const stack = stacks.find((s) => s.unitType === unitType);
    if (!stack || stack.count < count) return { ok: false, error: `Not enough ${unitType} to remove ${count}.` };
    stack.count -= count;
    stack.damagedCount = Math.min(stack.damagedCount, stack.count);
  }
  stacks = stacks.filter((s) => s.count > 0);

  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: stacks } };
  const nextState: GameState = openSpaceCombatWonWindowIfNeeded(
    { ...state, systems: { ...state.systems, [systemId]: updatedSystem }, pendingTacticalAction: { playerId: pending.playerId, systemId, step: "invasion" } },
    action.playerId,
  );
  return { ok: true, state: openInvasionStartWindowIfNeeded(nextState), events: [] };
}
