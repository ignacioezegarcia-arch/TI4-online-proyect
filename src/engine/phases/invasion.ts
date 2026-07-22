import { GameState, PlanetState, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId, AgendaId, asTechId } from "../types/ids";
import { UnitType, STRUCTURE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { usesCodex4Version } from "../rules/gameMode";
import { isLawActiveWithOutcome, getLawOwner, maybeApplyShardOfTheThroneOnCombatWin, maybeApplyCrownOfEmphidiaOnControlGain, maybeQueueCrownOfThalnosReroll, isDemilitarizedZone } from "./agendaEffects";
import {
  playersWithGroundForces,
  buildBombardmentEntries,
  buildGroundCombatEntries,
  buildSpaceCannonDefenseEntries,
  resolveCombatRound,
  applyHitAssignments,
  applySelfAssemblyRoutinesMechBonus,
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
 *  3. FINISH_INVASION_COMMITS — attacker signals no more planets will be
 *     invaded this tactical action. If nothing ended up contested, this
 *     goes straight to Production.
 *  4. START_GROUND_COMBAT(planetId) — the active player's own, independent
 *     choice of which contested planet resolves next (RR 44.4). Not tied
 *     to commit order, not tied to any previous pick — called again after
 *     each planet's combat ends, for as long as contested planets remain.
 *     If the defender on that planet has a qualifying PDS there, this
 *     opens a Space Cannon Defense window (their own optional choice,
 *     USE_SPACE_CANNON_DEFENSE / SKIP_SPACE_CANNON_DEFENSE) before ground
 *     combat's dice start rolling. Failing that, checks Magen Defense Grid
 *     (base version's optional block, or ΩΩ's automatic hit) — see that
 *     tech's own functions below. Skipped straight to ground combat if
 *     none of these apply.
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
 *  - Action cards / other technologies / faction abilities that modify any
 *    of this — same scope cut as combat.ts's own note on this.
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
  // RR "Conventions of War" ("for"): Bombardment can't target units on a cultural planet while this law is active.
  if (isLawActiveWithOutcome(state, "conventions_of_war" as AgendaId, "for") && (rules.planets[action.targetPlanetId]?.traits ?? []).includes("cultural")) {
    return { ok: false, error: 'RR "Conventions of War": Bombardment cannot target units on a cultural planet while this law is active.' };
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

  // RR "X-89 Bacterial Weapon" ΩΩ (Codex 4): "exhaust each planet you use
  // Bombardment against" — ALWAYS, on every bombardment roll, whether or
  // not it actually scores a hit (confirmed) — and a no-op if it's already
  // exhausted (not an error).
  const shouldExhaustTargetPlanet =
    usesCodex4Version(state.mode) && state.players[action.playerId]?.technologies.includes(asTechId("x89_bacterial_weapon"));
  const stateWithPlanetExhaust = shouldExhaustTargetPlanet && !planet.exhausted ? setPlanetExhausted(state, systemId, action.targetPlanetId) : state;

  if (hits === 0) {
    return { ok: true, state: stateWithPlanetExhaust, events };
  }

  const nextState: GameState = {
    ...stateWithPlanetExhaust,
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

  const result = applyHitAssignments(state, stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
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
    players: { ...state.players, [action.playerId]: applySelfAssemblyRoutinesMechBonus(player, result.destroyed) },
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
  if (isDemilitarizedZone(planet)) {
    return { ok: false, error: 'RR "Demilitarized Zone": units cannot land on this planet.' };
  }

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

  // RR "Magen Defense Grid": only checked if Space Cannon Defense didn't
  // already claim this window (simplification, flagged — the two aren't
  // offered together in the same call).
  const magenDefenseGridEligibility =
    defenderQualifies || !defenderId ? null : checkMagenDefenseGridEligibility(state, rules, defenderId, planet);

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
        : magenDefenseGridEligibility === "base"
          ? {
              ...pending,
              currentInvasionPlanetId: action.targetPlanetId,
              remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
              magenDefenseGridPending: true,
              pendingHits: {},
            }
          : magenDefenseGridEligibility === "omega_omega"
            ? {
                ...pending,
                currentInvasionPlanetId: action.targetPlanetId,
                remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
                magenDefenseGridAutoHitPending: true,
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

export function useMagenDefenseGrid(
  state: GameState,
  action: { type: "USE_MAGEN_DEFENSE_GRID"; playerId: PlayerId },
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44: no ground combat window currently open." };
  }
  if (!pending.magenDefenseGridPending) {
    return { ok: false, error: "RR: no Magen Defense Grid window currently open for this planet." };
  }
  const planet = state.systems[pending.systemId].planets.find((p) => p.planetId === pending.currentInvasionPlanetId)!;
  const defenderId = playersWithGroundForces(planet).find((id) => id !== pending.playerId);
  if (defenderId !== action.playerId) {
    return { ok: false, error: "RR: only the defending player can use Magen Defense Grid here." };
  }

  const player = state.players[action.playerId];
  const updatedPlayer = { ...player, exhaustedTechnologies: [...player.exhaustedTechnologies, asTechId("magen_defense_grid")] };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    pendingTacticalAction: {
      ...pending,
      magenDefenseGridPending: false,
      groundCombatAttackerBlockedThisRound: true,
      combatRound: 1,
    },
  };
  return { ok: true, state: nextState, events: [] };
}

export function skipMagenDefenseGrid(
  state: GameState,
  action: { type: "SKIP_MAGEN_DEFENSE_GRID"; playerId: PlayerId },
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44: no ground combat window currently open." };
  }
  if (!pending.magenDefenseGridPending) {
    return { ok: false, error: "RR: no Magen Defense Grid window currently open for this planet." };
  }
  const planet = state.systems[pending.systemId].planets.find((p) => p.planetId === pending.currentInvasionPlanetId)!;
  const defenderId = playersWithGroundForces(planet).find((id) => id !== pending.playerId);
  if (defenderId !== action.playerId) {
    return { ok: false, error: "RR: only the defending player can decide on Magen Defense Grid here." };
  }

  return {
    ok: true,
    state: { ...state, pendingTacticalAction: { ...pending, magenDefenseGridPending: false, combatRound: 1 } },
    events: [],
  };
}

/** RR "Magen Defense Grid" ΩΩ (Codex 4): the automatic (not optional, doesn't exhaust anything) hit at the start of ground combat — the defender still chooses WHICH of the attacker's units absorbs it. Kept separate from the normal pendingHits/ASSIGN_HITS flow so resolving it doesn't trigger wrapUpGroundCombat before round 1 has properly started. */
export function assignMagenDefenseGridHit(
  state: GameState,
  action: { type: "ASSIGN_MAGEN_DEFENSE_GRID_HIT"; playerId: PlayerId; assignment: { unitType: UnitType; outcome: "destroy" | "flip" } },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 44: no ground combat window currently open." };
  }
  if (!pending.magenDefenseGridAutoHitPending) {
    return { ok: false, error: "RR: no Magen Defense Grid hit is currently pending assignment." };
  }
  const systemId = pending.systemId;
  const planetId = pending.currentInvasionPlanetId;
  const planet = state.systems[systemId].planets.find((p) => p.planetId === planetId)!;
  const defenderId = playersWithGroundForces(planet).find((id) => id !== pending.playerId);
  if (defenderId !== action.playerId) {
    return { ok: false, error: "RR: only the defending player assigns this hit." };
  }

  // The hit lands on the ATTACKER (pending.playerId), same "who's the opponent here" direction as everything else in this step.
  const attackerId = pending.playerId;
  const attackerPlayer = state.players[attackerId];
  const attackerStacks = (planet.unitsByPlayer[attackerId] ?? []) as UnitStack[];
  const result = applyHitAssignments(state, attackerStacks, [action.assignment], 1, attackerPlayer.factionId, attackerPlayer.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR: ${result.error}` };

  const events: GameEvent[] = [
    ...Array.from(result.destroyed.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNITS_DESTROYED", playerId: attackerId, systemId, planetId, unitType, count }),
    ),
    ...Array.from(result.flipped.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNIT_SUSTAINED_DAMAGE", playerId: attackerId, systemId, planetId, unitType, count }),
    ),
  ];

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [attackerId]: result.stacks } };
  const updatedSystem: SystemState = { ...state.systems[systemId], planets: state.systems[systemId].planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) };

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    pendingTacticalAction: { ...pending, magenDefenseGridAutoHitPending: false, combatRound: 1 },
  };
  return { ok: true, state: nextState, events };
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

  const result = applyHitAssignments(state, stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR 44: ${result.error}` };

  const events: GameEvent[] = [
    ...Array.from(result.destroyed.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, planetId, unitType, count }),
    ),
    ...Array.from(result.flipped.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNIT_SUSTAINED_DAMAGE", playerId: action.playerId, systemId, planetId, unitType, count }),
    ),
  ];

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: result.stacks } };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) };

  const remainingPendingHits = { ...pending.pendingHits };
  delete remainingPendingHits[action.playerId];

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    players: { ...state.players, [action.playerId]: applySelfAssemblyRoutinesMechBonus(player, result.destroyed) },
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits, combatRound: 1 },
  };

  return { ok: true, state: nextState, events };
}

export function resolveGroundCombatRound(
  state: GameState,
  action: { type: "RESOLVE_COMBAT_ROUND"; playerId: PlayerId; diceRolls: number[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 38.1: no ground combat currently in progress." };
  }
  if (pending.spaceCannonDefensePending) {
    return { ok: false, error: "RR 44: resolve Space Cannon Defense before rolling ground combat dice." };
  }
  if (pending.pendingHits && Object.keys(pending.pendingHits).length > 0) {
    return { ok: false, error: "RR 38.2: the previous round's hits haven't all been assigned yet." };
  }

  const systemId = pending.systemId;
  const planetId = pending.currentInvasionPlanetId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId)!;

  const combatants = playersWithGroundForces(planet);
  if (!combatants.includes(action.playerId)) {
    return { ok: false, error: "RR 38.1: only a player with ground forces in this combat can submit its dice roll." };
  }

  let entries;
  try {
    entries = buildGroundCombatEntries(state, rules, planet, pending.groundCombatAttackerBlockedThisRound ? pending.playerId : undefined);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let result;
  try {
    result = resolveCombatRound(entries, action.diceRolls);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const [a, b] = combatants;
  const pendingHits: Partial<Record<PlayerId, number>> = {};
  if (result.hitsScoredByPlayer[a]) pendingHits[b] = result.hitsScoredByPlayer[a];
  if (result.hitsScoredByPlayer[b]) pendingHits[a] = result.hitsScoredByPlayer[b];

  const round = pending.combatRound ?? 1;
  const updatedPending = maybeQueueCrownOfThalnosReroll(state, { ...pending, combatRound: round, pendingHits }, result.missedDiceByPlayerAndType);
  let nextState: GameState = { ...state, pendingTacticalAction: updatedPending };
  const events: GameEvent[] = [
    { type: "COMBAT_ROUND_RESOLVED", systemId, planetId, round, hitsScoredByPlayer: result.hitsScoredByPlayer },
  ];

  if (Object.keys(pendingHits).length === 0 && (updatedPending.crownOfThalnosPendingPlayers ?? []).length === 0) {
    const wrap = wrapUpGroundCombat(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }
  return { ok: true, state: nextState, events };
}

export function assignGroundCombatHits(
  state: GameState,
  action: { type: "ASSIGN_HITS"; playerId: PlayerId; assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "RR 38.2: no ground combat currently in progress." };
  }
  const hitsOwed = pending.pendingHits?.[action.playerId];
  if (!hitsOwed || hitsOwed <= 0) {
    return { ok: false, error: "This player has no pending hits to assign right now." };
  }

  const systemId = pending.systemId;
  const planetId = pending.currentInvasionPlanetId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId)!;
  const player = state.players[action.playerId];
  const stacks = (planet.unitsByPlayer[action.playerId] ?? []) as UnitStack[];

  const result = applyHitAssignments(state, stacks, action.assignments, hitsOwed, player.factionId, player.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: `RR 38.2: ${result.error}` };

  const events: GameEvent[] = [
    ...Array.from(result.destroyed.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, planetId, unitType, count }),
    ),
    ...Array.from(result.flipped.entries()).map(
      ([unitType, count]): GameEvent => ({ type: "UNIT_SUSTAINED_DAMAGE", playerId: action.playerId, systemId, planetId, unitType, count }),
    ),
  ];

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: result.stacks } };
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)),
  };

  const remainingPendingHits = { ...pending.pendingHits };
  delete remainingPendingHits[action.playerId];

  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    players: { ...state.players, [action.playerId]: applySelfAssemblyRoutinesMechBonus(player, result.destroyed) },
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits },
  };

  if (Object.keys(remainingPendingHits).length === 0 && (pending.crownOfThalnosPendingPlayers ?? []).length === 0) {
    const wrap = wrapUpGroundCombat(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }
  return { ok: true, state: nextState, events };
}

// --- helpers ---------------------------------------------------------------

/** RR "Magen Defense Grid": which version (if any) this defender qualifies for on this planet, given their own owned/readied state and what's physically there. Returns null if they don't own it, or don't meet either version's own physical requirement. */
function checkMagenDefenseGridEligibility(state: GameState, rules: RuleData, defenderId: PlayerId, planet: PlanetState): "base" | "omega_omega" | null {
  const player = state.players[defenderId];
  const techId = asTechId("magen_defense_grid");
  if (!player.technologies.includes(techId)) return null;

  if (usesCodex4Version(state.mode)) {
    // ΩΩ: not exhaustable, needs 1+ structures (not specifically Planetary Shield) on this planet.
    const hasStructure = (planet.unitsByPlayer[defenderId] ?? []).some((s) => STRUCTURE_TYPES.includes(s.unitType) && s.count > 0);
    return hasStructure ? "omega_omega" : null;
  }

  // Base: must be readied, needs 1+ Planetary-Shield-capable units on this planet.
  if (player.exhaustedTechnologies.includes(techId)) return null;
  const hasPlanetaryShieldUnit = (planet.unitsByPlayer[defenderId] ?? []).some((s) => {
    if (s.count <= 0) return false;
    const stats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return stats?.abilities.includes("planetaryShield") ?? false;
  });
  return hasPlanetaryShieldUnit ? "base" : null;
}

/** RR "X-89 Bacterial Weapon" ΩΩ's own "exhaust each planet you use Bombardment against" clause — a plain exhaust, no control/legendary-ability side effects (unlike setPlanetController below, which is for actually GAINING control). */
function setPlanetExhausted(state: GameState, systemId: SystemId, planetId: PlanetId): GameState {
  const system = state.systems[systemId];
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)),
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}

function wrapUpGroundCombat(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingTacticalAction!;
  const systemId = pending.systemId;
  const planetId = pending.currentInvasionPlanetId!;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId)!;

  // Object.keys here (not playersWithGroundForces) on purpose — a
  // combatant wiped out to 0 units this round still has their (now empty)
  // stacks entry in unitsByPlayer, so this is the only reliable way to
  // recover "who was actually fighting here" for RR "Shard of the
  // Throne"'s own check below, once one side has been fully eliminated.
  const combatantsBeforeEnd = Object.keys(planet.unitsByPlayer) as PlayerId[];
  const survivors = playersWithGroundForces(planet);
  const events: GameEvent[] = [];
  let nextState = state;

  if (survivors.length <= 1) {
    const winner = survivors[0] ?? null;
    if (winner) {
      nextState = setPlanetController(nextState, systemId, planetId, winner, rules);
      nextState = maybeApplyShardOfTheThroneOnCombatWin(nextState, winner, combatantsBeforeEnd);
      events.push({ type: "PLANET_CONTROL_ESTABLISHED", systemId, planetId, playerId: winner });
    }
    events.push({ type: "GROUND_COMBAT_ENDED", systemId, planetId, survivingPlayerId: winner });

    const queue = pending.remainingInvasionPlanetIds ?? [];
    nextState = {
      ...nextState,
      pendingTacticalAction:
        queue.length > 0
          ? { ...pending, currentInvasionPlanetId: undefined, combatRound: undefined, pendingHits: {} }
          : { playerId: pending.playerId, systemId, step: "production" },
    };
    return { state: nextState, events };
  }

  // Both sides still standing — next round, no retreat option in ground combat (RR 38).
  // RR "Magen Defense Grid" (base version): its block only applies to the
  // ONE round it was used in — clear it here so round 2+ rolls normally.
  nextState = {
    ...nextState,
    pendingTacticalAction: {
      ...pending,
      combatRound: (pending.combatRound ?? 1) + 1,
      pendingHits: {},
      groundCombatAttackerBlockedThisRound: false,
    },
  };
  return { state: nextState, events };
}

/** RR 25.1: gaining control of a planet ALWAYS exhausts its planet card — no exceptions, regardless of how control was gained (invasion win, uncontested landing, anything else). RR 53.2: a legendary planet's separate ability card only readies if this is the FIRST time it's ever been controlled (i.e. it's coming "from the deck"); if it's being taken FROM another player, it keeps whatever exhausted/readied state it already had — untouched here, on purpose. */
function setPlanetController(state: GameState, systemId: SystemId, planetId: PlanetId, controllerId: PlayerId, rules: RuleData): GameState {
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId);
  if (!planet || planet.controllerId === controllerId) return state;

  const previousControllerId = planet.controllerId;
  const wasUncontrolled = previousControllerId === null;
  const isLegendary = rules.planets[planetId]?.isLegendary ?? false;

  const updatedPlanet: PlanetState = {
    ...planet,
    controllerId,
    exhausted: true,
    ...(wasUncontrolled && isLegendary ? { legendaryAbilityExhausted: false } : {}),
  };
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)),
  };
  let nextState: GameState = { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };

  // RR "Minister of Exploration": the owner gains 1 trade good whenever THEY gain control of a planet (any planet, doesn't have to be a new one).
  const ministerOfExplorationOwnerId = getLawOwner(nextState, "minister_of_exploration" as AgendaId);
  if (ministerOfExplorationOwnerId === controllerId) {
    const owner = nextState.players[controllerId];
    nextState = { ...nextState, players: { ...nextState.players, [controllerId]: { ...owner, tradeGoods: owner.tradeGoods + 1 } } };
  }

  // RR "Holy Planet of Ixth": gaining/losing control of ITS OWN attached
  // planet specifically gains/loses 1 VP — checked by whether this
  // planet actually has that card attached, not by which planet it is by
  // name, since attachment (not identity) is what the card's own text
  // keys off.
  if (planet.attachmentIds.includes("holy_planet_of_ixth")) {
    nextState = { ...nextState, players: { ...nextState.players, [controllerId]: { ...nextState.players[controllerId], victoryPoints: { ...nextState.players[controllerId].victoryPoints, current: nextState.players[controllerId].victoryPoints.current + 1 } } } };
    if (previousControllerId && nextState.players[previousControllerId]) {
      const prev = nextState.players[previousControllerId];
      nextState = { ...nextState, players: { ...nextState.players, [previousControllerId]: { ...prev, victoryPoints: { ...prev.victoryPoints, current: Math.max(0, prev.victoryPoints.current - 1) } } } };
    }
  }

  // RR "The Crown of Emphidia": transfers to `controllerId` if the planet
  // they just gained control of sits in the CURRENT owner's own home
  // system — checked here (not via maybeTransferVpCard's own generic
  // shape) since only this function knows which system this planet is in.
  const crownOwnerId = getLawOwner(nextState, "the_crown_of_emphidia" as AgendaId);
  if (crownOwnerId && crownOwnerId !== controllerId && rules.homeSystemByFaction[nextState.players[crownOwnerId]?.factionId] === systemId) {
    nextState = maybeApplyCrownOfEmphidiaOnControlGain(nextState, controllerId);
  }

  // RR PoK "Wormhole Nexus": gaining control of Mallice is the OTHER trigger for the active-flip (the first being a ship arriving there — see tacticalAction.ts's moveShips).
  return maybeActivateWormholeNexus(nextState, rules, systemId);
}
