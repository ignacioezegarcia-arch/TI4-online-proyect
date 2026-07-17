import { GameState, PlanetState, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData } from "../types/RuleData";
import {
  playersWithGroundForces,
  buildBombardmentEntries,
  buildGroundCombatEntries,
  buildSpaceCannonDefenseEntries,
  resolveCombatRound,
  applyHitAssignments,
  planetHasShield,
} from "../rules/combat";
import { maybeActivateWormholeNexus } from "../rules/adjacency";

/**
 * RR 78 STEP 4 — INVASION (RR 44).
 * Sub-steps, all the active player's choice except where noted — nothing
 * here is automatic:
 *  1. BOMBARD (optional, any number of times against different planets;
 *     attacker decides whether to bombard at all).
 *  2. COMMIT_GROUND_FORCES (optional, any number of times/planets).
 *  3. FINISH_INVASION_COMMITS — attacker signals they're done committing.
 *     If nothing ended up contested, this goes straight to Production.
 *  4. START_GROUND_COMBAT(planetId) — the active player's own, independent
 *     choice of which contested planet resolves next (RR 44.4). Not tied
 *     to commit order, not tied to any previous pick — called again after
 *     each planet's combat ends, for as long as contested planets remain.
 *     If the defender on that planet has a qualifying PDS there, this
 *     opens a Space Cannon Defense window (their own optional choice,
 *     USE_SPACE_CANNON_DEFENSE / SKIP_SPACE_CANNON_DEFENSE) before ground
 *     combat's dice start rolling; skipped automatically if they have none.
 *  5. Ground combat itself for whichever planet is current
 *     (RESOLVE_COMBAT_ROUND / ASSIGN_HITS, dispatched here instead of
 *     spaceCombat.ts based on `pendingTacticalAction.currentInvasionPlanetId`
 *     being set) — no retreat option, unlike space combat (RR 38 doesn't
 *     have one).
 *
 * NOT implemented yet, flagged rather than silently skipped:
 *  - A card/ability granting a Space Cannon Defense roll to a unit that
 *    doesn't actually have the ability — same category of gap as
 *    PLAY_ACTION_CARD not existing yet.
 *  - Action cards / technologies / faction abilities that modify any of
 *    this — same scope cut as combat.ts's own note on this.
 *  - Transport capacity enforcement (see moveShips' own TODO).
 */

export function bombard(
  state: GameState,
  action: {
    type: "BOMBARD";
    playerId: PlayerId;
    targetPlanetId: PlanetId;
    diceRolls: number[];
    /** RR "Plasma Scoring": which Bombardment-capable unit type gets the +1 die, if the player owns the tech and this matters (2+ qualifying types with different hitOn values) — see buildBombardmentEntries' own note. Ignored otherwise. */
    plasmaScoringUnitType?: import("../types/enums").UnitType;
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 44.1: no tactical action in progress for this player." };
  }
  if (pending.step !== "invasion") {
    return { ok: false, error: `RR 44.1: expected step "invasion", got "${pending.step}".` };
  }
  if (pending.currentInvasionPlanetId || (pending.pendingHits && Object.keys(pending.pendingHits).length > 0)) {
    return { ok: false, error: "RR 44.1: resolve the current pending hits before bombarding again." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
  if (!planet) return { ok: false, error: `No planet ${action.targetPlanetId} in ${systemId}.` };

  const defenders = playersWithGroundForces(planet).filter((p) => p !== action.playerId);
  if (defenders.length === 0) {
    return { ok: false, error: "RR 44.1: no other player's ground forces on this planet to bombard." };
  }
  if (defenders.length > 1) {
    return { ok: false, error: "RR 44.1: multiple defending players on one planet isn't supported yet." };
  }
  const defenderId = defenders[0];
  const defenderPlayer = state.players[defenderId];

  if (planetHasShield(planet, defenderId, defenderPlayer.factionId, defenderPlayer.unitUpgrades, rules)) {
    return { ok: false, error: `RR 15/44.1: ${action.targetPlanetId} has Planetary Shield — Bombardment can't target it.` };
  }

  const entries = buildBombardmentEntries(state, rules, systemId, action.playerId, action.plasmaScoringUnitType);
  if (entries.length === 0) {
    return { ok: false, error: "RR 44.1: this player has no Bombardment-capable units in this system." };
  }

  let result;
  try {
    result = resolveCombatRound(entries, action.diceRolls);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const hits = result.hitsScoredByPlayer[action.playerId] ?? 0;
  const events: GameEvent[] = [
    { type: "BOMBARDMENT_RESOLVED", playerId: action.playerId, systemId, planetId: action.targetPlanetId, hits },
  ];

  if (hits === 0) {
    return { ok: true, state, events };
  }

  const nextState: GameState = {
    ...state,
    pendingTacticalAction: {
      ...pending,
      currentInvasionPlanetId: action.targetPlanetId,
      pendingHits: { [defenderId]: hits },
    },
  };
  return { ok: true, state: nextState, events };
}

export function assignBombardmentHits(
  state: GameState,
  action: {
    type: "ASSIGN_BOMBARDMENT_HITS";
    playerId: PlayerId;
    targetPlanetId: PlanetId;
    assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: "RR 44.1: no tactical action in progress." };
  if (pending.step !== "invasion" || pending.currentInvasionPlanetId !== action.targetPlanetId) {
    return { ok: false, error: "RR 44.1: no bombardment against this planet is currently pending assignment." };
  }
  const hitsOwed = pending.pendingHits?.[action.playerId];
  if (!hitsOwed || hitsOwed <= 0) {
    return { ok: false, error: "This player has no pending bombardment hits to assign." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === action.targetPlanetId)!;
  const player = state.players[action.playerId];
  const stacks = (planet.unitsByPlayer[action.playerId] ?? []) as UnitStack[];

  const result = applyHitAssignments(stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR 44.1: ${result.error}` };

  const events: GameEvent[] = [
    ...Array.from(result.destroyed.entries()).map(
      ([unitType, count]): GameEvent => ({
        type: "UNITS_DESTROYED",
        playerId: action.playerId,
        systemId,
        planetId: action.targetPlanetId,
        unitType,
        count,
      }),
    ),
    ...Array.from(result.flipped.entries()).map(
      ([unitType, count]): GameEvent => ({
        type: "UNIT_SUSTAINED_DAMAGE",
        playerId: action.playerId,
        systemId,
        planetId: action.targetPlanetId,
        unitType,
        count,
      }),
    ),
  ];

  const updatedPlanet: PlanetState = {
    ...planet,
    unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: result.stacks },
  };
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)),
  };

  const remainingPendingHits = { ...pending.pendingHits };
  delete remainingPendingHits[action.playerId];

  // Bombardment is one-shot (not a repeating round like ground combat), so
  // once its hits are assigned we're back to the free-for-all commit phase.
  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    pendingTacticalAction: { ...pending, currentInvasionPlanetId: undefined, pendingHits: remainingPendingHits },
  };

  return { ok: true, state: nextState, events };
}

export function commitGroundForces(
  state: GameState,
  action: { type: "COMMIT_GROUND_FORCES"; playerId: PlayerId; targetPlanetId: PlanetId; units: { unitType: UnitType; count: number }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 44.2: no tactical action in progress for this player." };
  }
  if (pending.step !== "invasion") {
    return { ok: false, error: `RR 44.2: expected step "invasion", got "${pending.step}".` };
  }
  if (pending.invasionCommitsFinished) {
    return { ok: false, error: "RR 44.2: this player already finished committing ground forces this invasion step." };
  }
  if (pending.currentInvasionPlanetId || (pending.pendingHits && Object.keys(pending.pendingHits).length > 0)) {
    return { ok: false, error: "RR 44.2: resolve the current pending hits before committing more ground forces." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
  if (!planet) return { ok: false, error: `No planet ${action.targetPlanetId} in ${systemId}.` };

  const spaceStacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  let updatedSpaceStacks = spaceStacks.map((s) => ({ ...s }));
  let updatedPlanetStacks = (planet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));

  for (const { unitType, count } of action.units) {
    if (count <= 0) continue;
    const stack = updatedSpaceStacks.find((s) => s.unitType === unitType);
    if (!stack || stack.count < count) {
      return { ok: false, error: `Not enough ${unitType} in ${systemId}'s space area to commit ${count}.` };
    }
    stack.count -= count;
    const planetStack = updatedPlanetStacks.find((s) => s.unitType === unitType && !s.upgradeId);
    if (planetStack) planetStack.count += count;
    else updatedPlanetStacks.push({ unitType, count, damagedCount: 0 });
  }
  updatedSpaceStacks = updatedSpaceStacks.filter((s) => s.count > 0);

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: updatedPlanetStacks } };
  let updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks },
    planets: system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)),
  };

  let nextState: GameState = { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
  const events: GameEvent[] = [
    { type: "GROUND_FORCES_COMMITTED", playerId: action.playerId, systemId, planetId: action.targetPlanetId },
  ];

  const contested = playersWithGroundForces(updatedPlanet).length > 1;
  const alreadyPending =
    pending.currentInvasionPlanetId === action.targetPlanetId ||
    (pending.remainingInvasionPlanetIds ?? []).includes(action.targetPlanetId);

  if (contested) {
    if (!alreadyPending) {
      nextState = {
        ...nextState,
        pendingTacticalAction: {
          ...pending,
          remainingInvasionPlanetIds: [...(pending.remainingInvasionPlanetIds ?? []), action.targetPlanetId],
        },
      };
    }
  } else {
    // Uncontested landing — establish control immediately (RR 44.5), no combat needed.
    nextState = setPlanetController(nextState, systemId, action.targetPlanetId, action.playerId, rules);
    events.push({ type: "PLANET_CONTROL_ESTABLISHED", systemId, planetId: action.targetPlanetId, playerId: action.playerId });
  }

  return { ok: true, state: nextState, events };
}

export function finishInvasionCommits(
  state: GameState,
  action: { type: "FINISH_INVASION_COMMITS"; playerId: PlayerId },
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 44.2: no tactical action in progress for this player." };
  }
  if (pending.step !== "invasion") {
    return { ok: false, error: `RR 44.2: expected step "invasion", got "${pending.step}".` };
  }
  if (pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44.2: a ground combat is already in progress." };
  }

  const queue = pending.remainingInvasionPlanetIds ?? [];
  if (queue.length === 0) {
    // Nothing contested — straight to Production, no combat order to choose.
    return {
      ok: true,
      state: { ...state, pendingTacticalAction: { playerId: pending.playerId, systemId: pending.systemId, step: "production" } },
      events: [],
    };
  }

  return {
    ok: true,
    state: { ...state, pendingTacticalAction: { ...pending, invasionCommitsFinished: true } },
    events: [],
  };
}

/** RR 44.4: the active player's explicit, independent choice of which contested planet resolves next — not tied to commit order or any previous pick. */
export function startGroundCombat(
  state: GameState,
  action: { type: "START_GROUND_COMBAT"; playerId: PlayerId; targetPlanetId: PlanetId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 44.4: no tactical action in progress for this player." };
  }
  if (pending.step !== "invasion" || !pending.invasionCommitsFinished) {
    return { ok: false, error: "RR 44.4: finish committing ground forces (FINISH_INVASION_COMMITS) before choosing a combat to resolve." };
  }
  if (pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44.4: a ground combat is already in progress." };
  }
  const queue = pending.remainingInvasionPlanetIds ?? [];
  if (!queue.includes(action.targetPlanetId)) {
    return { ok: false, error: `RR 44.4: ${action.targetPlanetId} isn't a contested planet awaiting ground combat.` };
  }

  // RR 44's Space Cannon Defense: before ground combat starts, the defender
  // (if they have a qualifying PDS on THIS planet) gets the choice to fire
  // at the attacker's just-committed ground forces. Only relevant if
  // there's an actual defender with qualifying units — skip straight to
  // ground combat otherwise.
  const system = state.systems[pending.systemId];
  const planet = system.planets.find((p) => p.planetId === action.targetPlanetId)!;
  const defenderId = playersWithGroundForces(planet).find((id) => id !== action.playerId);
  const defenderQualifies = defenderId ? buildSpaceCannonDefenseEntries(state, rules, defenderId, planet, action.playerId).length > 0 : false;

  return {
    ok: true,
    state: {
      ...state,
      pendingTacticalAction: defenderQualifies
        ? {
            ...pending,
            currentInvasionPlanetId: action.targetPlanetId,
            remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
            spaceCannonDefensePending: true,
            pendingHits: {},
          }
        : {
            ...pending,
            currentInvasionPlanetId: action.targetPlanetId,
            remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
            combatRound: 1,
            pendingHits: {},
          },
    },
    events: [],
  };
}

export function useSpaceCannonDefense(
  state: GameState,
  action: { type: "USE_SPACE_CANNON_DEFENSE"; playerId: PlayerId; diceRolls: number[]; plasmaScoringUnitType?: UnitType },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44: no ground combat window currently open." };
  }
  if (!pending.spaceCannonDefensePending) {
    return { ok: false, error: "RR 44: no Space Cannon Defense window currently open for this planet." };
  }

  const systemId = pending.systemId;
  const planetId = pending.currentInvasionPlanetId;
  const planet = state.systems[systemId].planets.find((p) => p.planetId === planetId)!;
  const defenderId = playersWithGroundForces(planet).find((id) => id !== pending.playerId);
  if (defenderId !== action.playerId) {
    return { ok: false, error: "RR 44: only the defending player can use Space Cannon Defense here." };
  }

  const entries = buildSpaceCannonDefenseEntries(state, rules, action.playerId, planet, pending.playerId, action.plasmaScoringUnitType);
  if (entries.length === 0) return { ok: false, error: "This player has no qualifying Space Cannon units on this planet." };

  let result;
  try {
    result = resolveCombatRound(entries, action.diceRolls);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const hits = result.hitsScoredByPlayer[action.playerId] ?? 0;
  const events: GameEvent[] = [{ type: "SPACE_CANNON_DEFENSE_FIRED", playerId: action.playerId, systemId, planetId, hits }];

  let nextState: GameState = {
    ...state,
    pendingTacticalAction: {
      ...pending,
      spaceCannonDefensePending: false,
      pendingHits: hits > 0 ? { [pending.playerId]: hits } : {},
    },
  };

  if (hits === 0) {
    nextState = { ...nextState, pendingTacticalAction: { ...nextState.pendingTacticalAction!, combatRound: 1 } };
  }

  return { ok: true, state: nextState, events };
}

export function skipSpaceCannonDefense(
  state: GameState,
  action: { type: "SKIP_SPACE_CANNON_DEFENSE"; playerId: PlayerId },
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44: no ground combat window currently open." };
  }
  if (!pending.spaceCannonDefensePending) {
    return { ok: false, error: "RR 44: no Space Cannon Defense window currently open for this planet." };
  }

  const planet = state.systems[pending.systemId].planets.find((p) => p.planetId === pending.currentInvasionPlanetId)!;
  const defenderId = playersWithGroundForces(planet).find((id) => id !== pending.playerId);
  if (defenderId !== action.playerId) {
    return { ok: false, error: "RR 44: only the defending player can decide on Space Cannon Defense here." };
  }

  return {
    ok: true,
    state: { ...state, pendingTacticalAction: { ...pending, spaceCannonDefensePending: false, combatRound: 1 } },
    events: [{ type: "SPACE_CANNON_DEFENSE_SKIPPED", playerId: action.playerId }],
  };
}

export function assignSpaceCannonDefenseHits(
  state: GameState,
  action: { type: "ASSIGN_SPACE_CANNON_DEFENSE_HITS"; playerId: PlayerId; assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44: no ground combat window currently open." };
  }
  const hitsOwed = pending.pendingHits?.[action.playerId];
  if (!hitsOwed || hitsOwed <= 0) {
    return { ok: false, error: "This player has no pending Space Cannon Defense hits to assign." };
  }

  const systemId = pending.systemId;
  const planetId = pending.currentInvasionPlanetId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId)!;
  const player = state.players[action.playerId];
  const stacks = (planet.unitsByPlayer[action.playerId] ?? []) as UnitStack[];

  const result = applyHitAssignments(stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR 44: ${result.error}` };

  const events: GameEvent[] = [
    ...Array.from(result.destroyed.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, planetId, unitType, count }),
    ),
    ...Array.from(result.flipped.entries()).map(
      ([unitType, count])
