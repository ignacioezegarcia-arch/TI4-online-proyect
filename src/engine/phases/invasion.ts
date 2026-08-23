import { GameState, Player, PlanetState, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId, AgendaId, asTechId, asAbilityId, NEUTRAL_PLAYER_ID } from "../types/ids";
import { UnitType, STRUCTURE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { usesCodex4Version, hasPoKContent } from "../rules/gameMode";
import { isLawActiveWithOutcome, getLawOwner, isDemilitarizedZone } from "./agendaEffects";
import { maybeTransferShardOfTheThroneOnControlGain, maybeQueueCrownOfThalnosReroll } from "../rules/relics";
import { checkSpecOpsRespawn } from "../rules/sol";
import { checkReinforcementsAvailable } from "../rules/reinforcements";
import { has2ramBombardmentOverride, applyFealtyUplink } from "../rules/l1z1x";
import { applyExplorationCard, ExplorationCardChoice } from "./exploration";
import {
  playersWithGroundForces,
  buildBombardmentEntries,
  buildGroundCombatEntries,
  buildSpaceCannonDefenseEntries,
  resolveCombatRound,
  applyHitAssignments,
  computeNeutralHitAssignments,
  applySelfAssemblyRoutinesMechBonus,
  planetHasShield,
} from "../rules/combat";
import { maybeActivateWormholeNexus } from "../rules/adjacency";
import { hasEntropicScar } from "../rules/anomalies";
import { actionPhaseWindowOrder } from "../rules/priorityWindow";
import { hasAbility } from "../rules/abilities";
import { applyIconoclastOmegaOmegaDeploy } from "../rules/naalu";
import { applyRelicOnGainEffects } from "../rules/relics";

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
    /**
     * TE COEXIST (yjmrobert.com/tirules/rules/r_coexistence): when the
     * target planet has more than 1 defender (a coexisting pair), the
     * attacker chooses — independently, PER bombarding unit TYPE, in this
     * SAME roll — which defender's forces that unit type's hits are
     * assigned against. Unused/surplus hits from a unit type's own choice
     * are NOT transferable to a different defender. Required whenever
     * there's more than 1 defender; ignored (single implicit target)
     * otherwise.
     */
    targetPlayerIdByUnitType?: Partial<Record<import("../types/enums").UnitType, PlayerId>>;
    /** Jol-Nar "Ta Zern" (commander, passive): "After you roll dice for a unit ability, you may reroll any of those dice." Applied INLINE, right after this bombardment's own initial roll resolves (same "reroll = reroll missed, in every practical sense" reasoning as every other reroll ability here) — bundled into the SAME action rather than a separate follow-up, since (unlike Crown of Thalnos's own reroll, which has a real subsequent decision point via a priority window) Bombardment's hits get counted and applied in one shot with nothing to interrupt in between. */
    taZernRerolls?: { unitType: import("../types/enums").UnitType; newRolls: number[] }[];
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
  if (state.pendingPriorityWindow?.kind === "invasion_start" || state.pendingPriorityWindow?.kind === "space_combat_won") {
    return { ok: false, error: "RR 1.19/1.20: every eligible player must be given (and decline) their chance to play an invasion-start card before bombarding." };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
  if (!planet) return { ok: false, error: `No planet ${action.targetPlanetId} in ${systemId}.` };

  // TE ENTROPIC SCAR (rulebook p.11): Bombardment "cannot be used by or against units inside of an entropic scar."
  if (hasEntropicScar(system.anomalies)) {
    return { ok: false, error: "TE ENTROPIC SCAR: Bombardment cannot be used inside an entropic scar." };
  }

  const defenders = playersWithGroundForces(planet).filter((p) => p !== action.playerId);
  if (defenders.length === 0) {
    return { ok: false, error: "RR 44.1: no other player's ground forces on this planet to bombard." };
  }
  // For the Planetary Shield / Conventions of War checks below (both are
  // per-PLANET, not per-defender) any 1 defender works to look up the
  // planet's controller-adjacent state — those checks don't vary by which
  // coexisting defender is chosen.
  const primaryDefenderId = defenders[0];
  const defenderPlayer = state.players[primaryDefenderId];

  // RR 65.3: if the bombarding player has a war sun in this system, Planetary Shield is ignored entirely — see planetHasShield's own note.
  const attackerHasWarSunInSystem = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "war_sun" && s.count > 0);
  // "Disable": this attacker's opponents' PDS units lose Planetary Shield (and Space Cannon, checked separately in Space Cannon Defense) for the rest of this invasion.
  const disableActive = pending.disablePlayerId === action.playerId;

  if (!disableActive && !has2ramBombardmentOverride(state, action.playerId) && planetHasShield(planet, primaryDefenderId, defenderPlayer.factionId, defenderPlayer.unitUpgrades, rules, attackerHasWarSunInSystem)) {
    return { ok: false, error: `RR 15/44.1: ${action.targetPlanetId} has Planetary Shield — Bombardment can't target it.` };
  }
  // RR "Conventions of War" ("for"): Bombardment can't target units on a cultural planet while this law is active.
  if (isLawActiveWithOutcome(state, "conventions_of_war" as AgendaId, "for") && (rules.planets[action.targetPlanetId]?.traits ?? []).includes("cultural")) {
    return { ok: false, error: 'RR "Conventions of War": Bombardment cannot target units on a cultural planet while this law is active.' };
  }

  const entries = buildBombardmentEntries(state, rules, systemId, action.playerId, action.plasmaScoringUnitType, planet.controllerId ?? undefined, pending.currentInvasionPlanetId ? [pending.currentInvasionPlanetId] : []);
  if (entries.length === 0) {
    return { ok: false, error: "RR 44.1: this player has no Bombardment-capable units in this system." };
  }
  if (entries.reduce((sum, e) => sum + e.diceCount, 0) !== action.diceRolls.length) {
    return { ok: false, error: "RR 44.1: diceRolls length must match this player's total Bombardment dice count." };
  }

  // TE COEXIST: resolve each entry's OWN target (same roll, no repeated
  // bombarding) — single-defender case needs no per-unit-type choice at
  // all; the coexisting case requires one, entry by entry.
  const entryTargets: PlayerId[] = [];
  if (defenders.length === 1) {
    for (const _e of entries) entryTargets.push(defenders[0]);
  } else {
    for (const e of entries) {
      const target = e.unitType ? action.targetPlayerIdByUnitType?.[e.unitType] : undefined;
      if (!target || !defenders.includes(target)) {
        return { ok: false, error: `TE COEXIST: multiple defenders here (coexisting) — targetPlayerIdByUnitType must specify a valid defender for ${e.unitType ?? "this unit type"}.` };
      }
      entryTargets.push(target);
    }
  }

  // Slice the flat diceRolls per entry (same "iterate stacks in order" convention this project's own BOMBARD action doc comment already establishes), then group by chosen target so each coexisting defender's own hits are resolved independently — a unit type's own unused/surplus hits never carry over to a different defender, since each target's own resolveCombatRound call only ever sees the entries actually aimed at it.
  const hitsByTarget: Record<string, number> = {};
  for (const target of new Set(entryTargets)) {
    const targetEntries: typeof entries = [];
    const targetDice: number[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i++) {
      const entryDice = action.diceRolls.slice(offset, offset + entries[i].diceCount);
      if (entryTargets[i] === target) {
        targetEntries.push(entries[i]);
        targetDice.push(...entryDice);
      }
      offset += entries[i].diceCount;
    }
    let result;
    try {
      result = resolveCombatRound(targetEntries, targetDice);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    hitsByTarget[target] = result.hitsScoredByPlayer[action.playerId] ?? 0;

    // Jol-Nar "Ta Zern" (commander, passive): applied inline, right here, against THIS target's own missed dice specifically. KNOWN SCOPE LIMIT: only supported for the single-target case (the overwhelming majority of bombardments) — with 2+ coexisting defenders targeted differently per unit type, this project doesn't currently disambiguate which target a rerolled die's own bonus hit should go to, so Ta Zern simply isn't offered there (this specific narrower case, not silently mishandled).
    if (action.taZernRerolls && new Set(entryTargets).size === 1) {
      const player = state.players[action.playerId];
      const commanderEntry = player?.leaders.find((l) => l.leaderId === ("jolnar_commander" as never));
      if (!commanderEntry || commanderEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Ta Zern." };
      for (const { unitType, newRolls } of action.taZernRerolls) {
        const availableMisses = result.missedDiceByPlayerAndType[action.playerId]?.[unitType] ?? 0;
        if (newRolls.length > availableMisses) {
          return { ok: false, error: `Ta Zern: tried to reroll ${newRolls.length} ${unitType} dice, only ${availableMisses} missed.` };
        }
        const matchingEntry = targetEntries.find((e) => e.unitType === unitType);
        if (!matchingEntry) return { ok: false, error: `This player has no ${unitType} in this bombardment.` };
        hitsByTarget[target] += newRolls.filter((r) => r >= matchingEntry.hitOn).length;
      }
    }
  }

  // "Bunker"/"Blitz" timing: this invasion step has now definitively started, whether or not this roll scores a hit.
  const state1: GameState = { ...state, pendingTacticalAction: { ...pending, invasionStepStarted: true } };

  const events: GameEvent[] = Object.entries(hitsByTarget).map(
    ([defenderId, hits]): GameEvent => ({ type: "BOMBARDMENT_RESOLVED", playerId: action.playerId, systemId, planetId: action.targetPlanetId, hits, targetPlayerId: defenderId as PlayerId }),
  );

  // RR "X-89 Bacterial Weapon" ΩΩ (Codex 4): "exhaust each planet you use
  // Bombardment against" — ALWAYS, on every bombardment roll, whether or
  // not it actually scores a hit (confirmed) — and a no-op if it's already
  // exhausted (not an error).
  const shouldExhaustTargetPlanet =
    usesCodex4Version(state.mode) && state.players[action.playerId]?.technologies.includes(asTechId("x89_bacterial_weapon"));
  const stateWithPlanetExhaust = shouldExhaustTargetPlanet && !planet.exhausted ? setPlanetExhausted(state1, systemId, action.targetPlanetId) : state1;

  const totalHits = Object.values(hitsByTarget).reduce((sum, h) => sum + h, 0);
  if (totalHits === 0) {
    return { ok: true, state: stateWithPlanetExhaust, events };
  }

  const pendingHitsUpdate: Record<string, number> = {};
  for (const [defId, hits] of Object.entries(hitsByTarget)) {
    if (hits > 0) pendingHitsUpdate[defId] = hits;
  }

  const nextState: GameState = {
    ...stateWithPlanetExhaust,
    pendingTacticalAction: {
      ...pending,
      invasionStepStarted: true,
      currentInvasionPlanetId: action.targetPlanetId,
      pendingHits: pendingHitsUpdate,
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

  // TE NEUTRAL UNITS: same fixed-priority-order reasoning as everywhere else this project computes hit assignments for the neutral pseudo-player.
  const bombardAssignments = action.playerId === NEUTRAL_PLAYER_ID ? computeNeutralHitAssignments(stacks, hitsOwed, hasEntropicScar(system.anomalies)) : action.assignments;

  const result = applyHitAssignments(state, stacks, bombardAssignments, hitsOwed, player.factionId, player.unitUpgrades, rules, system.anomalies, undefined, player.technologies.includes("non_euclidean_shielding" as never));
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

/** Called at every point across this project where pendingTacticalAction might have JUST transitioned to step "invasion" — opens the RR 1.19 "invasion_start" priority window (rules/priorityWindow.ts) for the attacker plus every OTHER player with a controlled planet or ground forces in that system (a defender need not have EITHER for the attacker themselves to still want Blitz, so the attacker is always included even with 0 defenders present). A safe no-op if invasionStepStarted is already true (bombard/commitGroundForces already ran — see that flag's own doc comment) or a window is somehow already open. */
export function openInvasionStartWindowIfNeeded(state: GameState): GameState {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || pending.invasionStepStarted) return state;
  if (state.pendingPriorityWindow) return state;
  const system = state.systems[pending.systemId];
  if (!system) return state;
  const defenders = new Set<PlayerId>();
  for (const planet of system.planets) {
    if (planet.controllerId && planet.controllerId !== pending.playerId) defenders.add(planet.controllerId);
    for (const pid of Object.keys(planet.unitsByPlayer) as PlayerId[]) {
      if (pid !== pending.playerId && (planet.unitsByPlayer[pid] ?? []).some((s) => s.count > 0)) defenders.add(pid);
    }
  }
  const order = actionPhaseWindowOrder(state, pending.playerId, [pending.playerId, ...defenders]);
  if (order.length === 0) return state;
  return { ...state, pendingPriorityWindow: { kind: "invasion_start", order, currentIndex: 0, consecutivePasses: 0 } };
}

/** Ground-combat mirror of phases/spaceCombat.ts's own openCombatRoundStartWindowIfNeeded — called at every point in this file where pendingTacticalAction might have JUST landed on a genuine "a ground combat round begins now" state (round 1, once Space Cannon Defense/Magen Defense Grid have both already resolved or never triggered, OR round N+1 right after the previous round wrapped up). Opens the SAME "combat_round_start" `kind` space combat uses — Morale Boost's own timing ("at the start of A combat round") doesn't distinguish space from ground, so they share 1 window kind. */
function openGroundCombatRoundStartWindowIfNeeded(state: GameState): GameState {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId || pending.combatRound === undefined) return state;
  if (pending.spaceCannonDefensePending || pending.magenDefenseGridPending || pending.magenDefenseGridAutoHitPending) return state;
  if (state.pendingPriorityWindow) return state;
  const planet = state.systems[pending.systemId]?.planets.find((p) => p.planetId === pending.currentInvasionPlanetId);
  if (!planet) return state;
  const participants = playersWithGroundForces(planet);
  const order = actionPhaseWindowOrder(state, pending.playerId, participants);
  if (order.length === 0) return state;
  return { ...state, pendingPriorityWindow: { kind: "combat_round_start", order, currentIndex: 0, consecutivePasses: 0 } };
}

export function commitGroundForces(
  state: GameState,
  action: { type: "COMMIT_GROUND_FORCES"; playerId: PlayerId; targetPlanetId: PlanetId; units: { unitType: UnitType; count: number }[]; coexist?: boolean; chosenTrait?: "cultural" | "industrial" | "hazardous"; explorationChoice?: ExplorationCardChoice },
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
  // RR "Parley" (yjmrobert.com/tirules/components/c_action_cards): "The returned ground forces cannot be committed to another planet during the same tactical action."
  if (pending.parleyBlockedPlayerIds?.includes(action.playerId)) {
    return { ok: false, error: 'RR "Parley": this player\'s Parley-returned ground forces cannot be recommitted this tactical action.' };
  }
  if (pending.currentInvasionPlanetId || (pending.pendingHits && Object.keys(pending.pendingHits).length > 0)) {
    return { ok: false, error: "RR 44.2: resolve the current pending hits before committing more ground forces." };
  }
  if (state.pendingPriorityWindow?.kind === "invasion_start" || state.pendingPriorityWindow?.kind === "space_combat_won") {
    return { ok: false, error: "RR 1.19/1.20: every eligible player must be given (and decline) their chance to play an invasion-start card before committing ground forces." };
  }
  // RR 27.1: units cannot commit ground forces to land on Mecatol Rex
  // while the custodians token is still there — see useRemoveCustodiansToken
  // below for the one path that both removes it AND lands forces in the
  // same action.
  if (pending.systemId === (rules.mecatolSystemId as SystemId) && !state.mecatolCustodiansRemoved) {
    return { ok: false, error: 'RR 27.1: cannot commit ground forces to land on Mecatol Rex until the custodians token is removed (see USE_REMOVE_CUSTODIANS_TOKEN).' };
  }

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
  if (!planet) return { ok: false, error: `No planet ${action.targetPlanetId} in ${systemId}.` };
  if (isDemilitarizedZone(planet)) {
    return { ok: false, error: 'RR "Demilitarized Zone": units cannot land on this planet.' };
  }
  // TE SPACE STATIONS (rulebook p.10): "structures and ground forces cannot be placed on or committed to space stations."
  if (planet.isSpaceStation) {
    return { ok: false, error: "TE SPACE STATIONS: ground forces cannot be committed to a space station." };
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

  let nextState: GameState = { ...state, systems: { ...state.systems, [systemId]: updatedSystem }, pendingTacticalAction: { ...pending, invasionStepStarted: true } };
  const events: GameEvent[] = [
    { type: "GROUND_FORCES_COMMITTED", playerId: action.playerId, systemId, planetId: action.targetPlanetId },
  ];

  const contested = playersWithGroundForces(updatedPlanet).length > 1;
  const alreadyPending =
    pending.currentInvasionPlanetId === action.targetPlanetId ||
    (pending.remainingInvasionPlanetIds ?? []).includes(action.targetPlanetId);

  // TE COEXIST: offered only when this specific commit would otherwise
  // start a NEW contest for THIS player (i.e. planet.controllerId is some
  // other player and this player's units weren't already coexisting there
  // before this commit) — once already coexisting, further commits by the
  // SAME player just join their own existing coexistence automatically
  // below, there's no repeated "choose to coexist" moment for them.
  const alreadyCoexistingHere = (updatedPlanet.coexistingPlayerIds ?? []).includes(action.playerId);
  if (alreadyCoexistingHere) {
    // Further commits by the SAME already-coexisting player just settle in peacefully — no re-choice needed, no combat queued.
    return { ok: true, state: nextState, events };
  }
  if (action.coexist && contested) {
    if (!hasAbility(nextState.players[action.playerId], asAbilityId("can_choose_coexist"))) {
      return { ok: false, error: "TE COEXIST: this player has no ability granting the choice to coexist here." };
    }
    const priorControllerId = planet.controllerId;
    let coexistedPlanet: PlanetState = { ...updatedPlanet, coexistingPlayerIds: [...(updatedPlanet.coexistingPlayerIds ?? []), action.playerId] };
    // "The player whose units triggered coexistence does not gain or
    // retain control; if they already controlled it, the player they are
    // now coexisting with gains control instead, exhausted." The common
    // case (committing onto ANOTHER player's still-controlled planet)
    // needs no change at all — control simply never moves to the
    // committing player in the first place. If there are multiple OTHER
    // parties already present (a 3+-way coexistence), the rule doesn't
    // specify which one becomes the new controller in this edge case —
    // picking the first found is a reasonable, deterministic choice.
    if (priorControllerId === action.playerId) {
      const otherPartyId = (Object.keys(updatedPlanet.unitsByPlayer) as PlayerId[]).find((id) => id !== action.playerId && (updatedPlanet.unitsByPlayer[id] ?? []).some((s) => s.count > 0));
      if (otherPartyId) {
        coexistedPlanet = { ...coexistedPlanet, controllerId: otherPartyId, exhausted: true, coexistingPlayerIds: (coexistedPlanet.coexistingPlayerIds ?? []).filter((id) => id !== otherPartyId) };
      }
    }
    const systemWithCoexist: SystemState = { ...nextState.systems[systemId], planets: nextState.systems[systemId].planets.map((p) => (p.planetId === action.targetPlanetId ? coexistedPlanet : p)) };
    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: systemWithCoexist } };
    events.push({ type: "COEXISTENCE_STARTED", systemId, planetId: action.targetPlanetId, coexistingPlayerId: action.playerId });
    return { ok: true, state: nextState, events };
  }

  if (contested) {
    // TE DUAL PLANET TRAITS: same validation as the uncontested branch below — banked now (dualTraitChoices) since control won't actually be established until combat concludes, possibly several rounds from now.
    const traitsHereContested = (rules.planets[action.targetPlanetId]?.traits ?? []) as ("cultural" | "industrial" | "hazardous")[];
    if (planet.controllerId === null && traitsHereContested.length > 1 && (!action.chosenTrait || !traitsHereContested.includes(action.chosenTrait))) {
      return { ok: false, error: `TE DUAL PLANET TRAITS: ${action.targetPlanetId} has multiple traits (${traitsHereContested.join("/")}) — chosenTrait must specify which one to explore with.` };
    }
    if (!alreadyPending) {
      nextState = {
        ...nextState,
        pendingTacticalAction: {
          ...nextState.pendingTacticalAction!,
          remainingInvasionPlanetIds: [...(pending.remainingInvasionPlanetIds ?? []), action.targetPlanetId],
          ...(action.chosenTrait ? { dualTraitChoices: { ...pending.dualTraitChoices, [action.targetPlanetId]: action.chosenTrait } } : {}),
          ...(action.explorationChoice ? { pendingExplorationChoices: { ...pending.pendingExplorationChoices, [action.targetPlanetId]: action.explorationChoice } } : {}),
        },
      };
    }
  } else {
    // Uncontested landing — establish control immediately (RR 44.5), no combat needed.
    // TE DUAL PLANET TRAITS: if this would be this planet's very first-ever control (triggering RR 25.1c's own automatic exploration) and it has 2 traits, the committing player must specify which one right here — they already know which planet is at stake when submitting this same action.
    const traitsHere = (rules.planets[action.targetPlanetId]?.traits ?? []) as ("cultural" | "industrial" | "hazardous")[];
    if (planet.controllerId === null && traitsHere.length > 1 && (!action.chosenTrait || !traitsHere.includes(action.chosenTrait))) {
      return { ok: false, error: `TE DUAL PLANET TRAITS: ${action.targetPlanetId} has multiple traits (${traitsHere.join("/")}) — chosenTrait must specify which one to explore with.` };
    }
    const controlResult = setPlanetController(nextState, systemId, action.targetPlanetId, action.playerId, rules, action.chosenTrait, action.explorationChoice);
    const previousControllerId = planet.controllerId;
    nextState = controlResult.state;
    events.push(...controlResult.events, { type: "PLANET_CONTROL_ESTABLISHED", systemId, planetId: action.targetPlanetId, playerId: action.playerId });

    // RR "Infiltrate"/"Reparations": both react to control just changing — same window, participants are whoever could plausibly react (the new controller, and the previous one if it was a different, non-eliminated player).
    const controlParticipants = [action.playerId, ...(previousControllerId && previousControllerId !== action.playerId && !nextState.players[previousControllerId]?.eliminated ? [previousControllerId] : [])];
    const controlOrder = actionPhaseWindowOrder(nextState, action.playerId, controlParticipants);
    if (controlOrder.length > 0) {
      return {
        ok: true,
        state: { ...nextState, pendingPlanetControlGainedContinuation: "check_ground_forces_committed", pendingPriorityWindow: { kind: "planet_control_gained", order: controlOrder, currentIndex: 0, consecutivePasses: 0 } },
        events,
      };
    }
  }

  return checkGroundForcesCommittedWindow(nextState, action.playerId, systemId, events);
}

/** RR "Parley"/"Ghost Squad": both react to ground forces just having been committed to land — opens regardless of contested/uncontested, for whoever else controls a planet in this system (only they could plausibly want either card). Split out so it's reachable both inline (no "planet_control_gained" reaction needed first) and from GameEngine.ts, once that window closes with pendingPlanetControlGainedContinuation === "check_ground_forces_committed". */
export function checkGroundForcesCommittedWindow(state: GameState, playerId: PlayerId, systemId: SystemId, events: GameEvent[]): ActionResult {
  const system = state.systems[systemId];
  const otherControllersHere = [...new Set((system?.planets ?? []).filter((p) => p.controllerId && p.controllerId !== playerId).map((p) => p.controllerId as PlayerId))].filter(
    (id) => !state.players[id]?.eliminated,
  );
  const commitOrder = actionPhaseWindowOrder(state, playerId, otherControllersHere);
  if (commitOrder.length > 0) {
    return { ok: true, state: { ...state, pendingPriorityWindow: { kind: "ground_forces_committed", order: commitOrder, currentIndex: 0, consecutivePasses: 0 } }, events };
  }
  return { ok: true, state, events };
}

/**
 * RR 27.2: before the "Commit Ground Forces" step, the active player may
 * remove the custodians token from Mecatol Rex by spending six influence
 * — then they MUST commit at least one ground force to land there in
 * this same action (RR: "if a player cannot commit ground forces to land
 * on Mecatol Rex, they cannot remove the custodians token"). Pays the
 * cost + flips the flag + grants the VP first, then reuses
 * commitGroundForces' own logic for the actual landing (now unblocked,
 * since the token is already gone by the time that runs).
 */
export function useRemoveCustodiansToken(
  state: GameState,
  action: { type: "USE_REMOVE_CUSTODIANS_TOKEN"; playerId: PlayerId; exhaustPlanetIdsForInfluence: PlanetId[]; units: { unitType: UnitType; count: number }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "invasion") {
    return { ok: false, error: "RR 27.2: no eligible tactical action for this player right now." };
  }
  if (pending.systemId !== (rules.mecatolSystemId as SystemId)) {
    return { ok: false, error: "RR 27.2: the active system isn't Mecatol Rex's." };
  }
  if (state.mecatolCustodiansRemoved) {
    return { ok: false, error: "RR 27.2: the custodians token has already been removed." };
  }
  const totalGroundForces = action.units.reduce((sum, u) => sum + u.count, 0);
  if (totalGroundForces <= 0) {
    return { ok: false, error: "RR 27.2: must commit at least 1 ground force to land on Mecatol Rex to remove the custodians token." };
  }

  let influence = 0;
  let nextState: GameState = state;
  for (const planetId of action.exhaustPlanetIdsForInfluence) {
    const entry = Object.entries(nextState.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    const planet = entry?.[1].planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const data = rules.planets[planetId];
    if (!data) return { ok: false, error: `No static data for ${planetId}.` };
    influence += data.influence;
    const [systemId, system] = entry!;
    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)) } } };
  }
  const player = nextState.players[action.playerId];
  const fromTradeGoods = Math.max(0, 6 - influence);
  if (fromTradeGoods > player.tradeGoods) {
    return { ok: false, error: `RR 27.2: not enough to pay 6 influence: ${influence} from exhausted planets + only ${player.tradeGoods} trade goods.` };
  }

  const updatedPlayer: Player = { ...player, tradeGoods: player.tradeGoods - fromTradeGoods, victoryPoints: { ...player.victoryPoints, current: player.victoryPoints.current + 1 } };
  nextState = {
    ...nextState,
    mecatolCustodiansRemoved: true,
    players: { ...nextState.players, [action.playerId]: updatedPlayer },
  };

  const mecatolPlanet = nextState.systems[pending.systemId]?.planets.find((p) => rules.planets[p.planetId]?.isMecatolRex);
  if (!mecatolPlanet) return { ok: false, error: "No Mecatol Rex planet found in this system." };

  const committed = commitGroundForces(nextState, { type: "COMMIT_GROUND_FORCES", playerId: action.playerId, targetPlanetId: mecatolPlanet.planetId, units: action.units }, rules);
  if (!committed.ok) return committed;

  return { ok: true, state: committed.state, events: committed.events };
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

  // Sardakk N'orr "Sh'val, Harbinger — TEKKLAR CONDITIONING" (hero): "after
  // you commit ground forces to land on planets, purge this card and
  // return each of your ships in the active system to your
  // reinforcements." Confirmed (tirules2.com/F_norr): applied right here,
  // as commits are finalized (not waiting on any ensuing combat to
  // resolve first) — this project's own simplification for "after you
  // commit ground forces" as a whole completed action.
  let workingState = state;
  if (pending.shvalHarbingerActive) {
    const player = workingState.players[action.playerId];
    const updatedPlayer: Player = { ...player, leaders: player.leaders.filter((l) => l.leaderId !== ("sardakk_hero" as never)) };
    const system = workingState.systems[pending.systemId];
    const updatedSystem = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: [] } };
    workingState = { ...workingState, players: { ...workingState.players, [action.playerId]: updatedPlayer }, systems: { ...workingState.systems, [pending.systemId]: updatedSystem } };
  }

  const queue = pending.remainingInvasionPlanetIds ?? [];
  if (queue.length === 0) {
    // Nothing contested — straight to Production, no combat order to choose.
    return {
      ok: true,
      state: { ...workingState, pendingTacticalAction: { playerId: pending.playerId, systemId: pending.systemId, step: "production" } },
      events: [],
    };
  }

  return {
    ok: true,
    state: { ...workingState, pendingTacticalAction: { ...pending, invasionCommitsFinished: true } },
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
  // TE COEXIST: a fresh ground combat is always attacker-vs-CONTROLLER
  // specifically (rule 9: "must start a ground combat against the player
  // that controls that planet") — never against some other coexisting
  // bystander, even if one happens to also be present on this planet.
  // Falls back to the old "any other party present" behavior only in the
  // (should-be-impossible outside Thunder's Edge) case of a contested
  // planet with no controller at all.
  const defenderId = planet.controllerId ?? playersWithGroundForces(planet).find((id) => id !== action.playerId);
  const defenderQualifies = defenderId ? buildSpaceCannonDefenseEntries(state, rules, defenderId, planet, action.playerId).length > 0 : false;

  // RR "Magen Defense Grid": only checked if Space Cannon Defense didn't
  // already claim this window (simplification, flagged — the two aren't
  // offered together in the same call).
  const magenDefenseGridEligibility =
    defenderQualifies || !defenderId ? null : checkMagenDefenseGridEligibility(state, rules, defenderId, planet, action.playerId, pending.systemId);

  const participantIds: [PlayerId, PlayerId] | undefined = defenderId ? [action.playerId, defenderId] : undefined;

  const resultState: GameState = {
    ...state,
    pendingTacticalAction: defenderQualifies
      ? {
          ...pending,
          currentInvasionPlanetId: action.targetPlanetId,
          remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
          groundCombatParticipantIds: participantIds,
          spaceCannonDefensePending: true,
          pendingHits: {},
        }
      : magenDefenseGridEligibility === "base"
        ? {
            ...pending,
            currentInvasionPlanetId: action.targetPlanetId,
            remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
            groundCombatParticipantIds: participantIds,
            magenDefenseGridPending: true,
            pendingHits: {},
          }
        : magenDefenseGridEligibility === "omega_omega"
          ? {
              ...pending,
              currentInvasionPlanetId: action.targetPlanetId,
              remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
              groundCombatParticipantIds: participantIds,
              magenDefenseGridAutoHitPending: true,
              pendingHits: {},
            }
          : {
              ...pending,
              currentInvasionPlanetId: action.targetPlanetId,
              remainingInvasionPlanetIds: queue.filter((id) => id !== action.targetPlanetId),
              groundCombatParticipantIds: participantIds,
              combatRound: 1,
              pendingHits: {},
            },
  };
  return { ok: true, state: openGroundCombatRoundStartWindowIfNeeded(resultState), events: [] };
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
  return { ok: true, state: openGroundCombatRoundStartWindowIfNeeded(nextState), events: [] };
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
    state: openGroundCombatRoundStartWindowIfNeeded({ ...state, pendingTacticalAction: { ...pending, magenDefenseGridPending: false, combatRound: 1 } }),
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
  return { ok: true, state: openGroundCombatRoundStartWindowIfNeeded(nextState), events };
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
    nextState = openGroundCombatRoundStartWindowIfNeeded({ ...nextState, pendingTacticalAction: { ...nextState.pendingTacticalAction!, combatRound: 1 } });
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
    state: openGroundCombatRoundStartWindowIfNeeded({ ...state, pendingTacticalAction: { ...pending, spaceCannonDefensePending: false, combatRound: 1 } }),
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

  // TE NEUTRAL UNITS: same fixed-priority-order reasoning as everywhere else this project computes hit assignments for the neutral pseudo-player.
  const scdAssignments = action.playerId === NEUTRAL_PLAYER_ID ? computeNeutralHitAssignments(stacks, hitsOwed, hasEntropicScar(system.anomalies)) : action.assignments;

  const result = applyHitAssignments(state, stacks, scdAssignments, hitsOwed, player.factionId, player.unitUpgrades, rules, system.anomalies, undefined, player.technologies.includes("non_euclidean_shielding" as never));
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

  return { ok: true, state: openGroundCombatRoundStartWindowIfNeeded(nextState), events };
}

export function resolveGroundCombatRound(
  state: GameState,
  action: { type: "RESOLVE_COMBAT_ROUND"; playerId: PlayerId; diceRolls: number[]; evelynDelouisBonus?: { ownerId: PlayerId; targetPlayerId: PlayerId; unitType: "infantry" | "mech" } },
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
  if (state.pendingPriorityWindow?.kind === "combat_round_start") {
    return { ok: false, error: "RR 1.19: every combatant must be given (and decline) their chance to play a round-start card before dice can be rolled." };
  }

  const systemId = pending.systemId;
  const planetId = pending.currentInvasionPlanetId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId)!;

  const combatants = pending.groundCombatParticipantIds ?? playersWithGroundForces(planet);
  if (!combatants.includes(action.playerId)) {
    return { ok: false, error: "RR 38.1: only a player with ground forces in this combat can submit its dice roll." };
  }

  // Sol "Evelyn DeLouis" (agent): validated + exhausted here, right before the round's own dice entries get built, since her bonus die needs to already be reflected in them. FIXED: the owner (whoever holds Evelyn) need NOT be a combatant themselves — an agent's ability can be used to benefit ANY player, including one who isn't the owner and isn't even fighting here; only the TARGET (whose unit actually gets the bonus die) must be a combatant.
  let workingState = state;
  if (action.evelynDelouisBonus) {
    const evelynOwner = workingState.players[action.evelynDelouisBonus.ownerId];
    const evelynEntry = evelynOwner?.leaders.find((l) => l.leaderId === ("sol_agent" as never));
    if (!evelynEntry) return { ok: false, error: "That player doesn't have Evelyn DeLouis." };
    if (evelynEntry.exhausted) return { ok: false, error: "Evelyn DeLouis is already exhausted." };
    if (!combatants.includes(action.evelynDelouisBonus.targetPlayerId)) return { ok: false, error: "That target isn't a combatant in this ground combat." };
    workingState = {
      ...workingState,
      players: {
        ...workingState.players,
        [action.evelynDelouisBonus.ownerId]: { ...evelynOwner, leaders: evelynOwner.leaders.map((l) => (l.leaderId === ("sol_agent" as never) ? { ...l, exhausted: true } : l)) },
      },
    };
  }

  let entries;
  try {
    entries = buildGroundCombatEntries(
      workingState,
      rules,
      planet,
      pending.groundCombatAttackerBlockedThisRound ? pending.playerId : undefined,
      pending.groundCombatParticipantIds,
      action.evelynDelouisBonus && { targetPlayerId: action.evelynDelouisBonus.targetPlayerId, unitType: action.evelynDelouisBonus.unitType },
      pending.tekklarLegionHolderIdThisCombat,
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

  const [a, b] = combatants;
  const pendingHits: Partial<Record<PlayerId, number>> = {};
  if (result.hitsScoredByPlayer[a]) pendingHits[b] = result.hitsScoredByPlayer[a];
  if (result.hitsScoredByPlayer[b]) pendingHits[a] = result.hitsScoredByPlayer[b];

  // Sardakk N'orr "Valkyrie Particle Weave" (faction tech): "After making
  // combat rolls during a round of ground combat, if your opponent
  // produced 1 or more hits, you produce 1 additional hit." Confirmed
  // (tirules2.com/F_norr): mandatory (not "may"); added to whatever hits
  // were already produced in this SAME Roll Dice step, before any
  // cancellation — modeled here as simply adding to pendingHits directly,
  // the earliest point that's true; N'orr producing 0 hits themselves
  // doesn't block this (only the OPPONENT's own hit count matters).
  for (const [selfId, opponentId] of [[a, b], [b, a]] as [PlayerId, PlayerId][]) {
    const selfPlayer = workingState.players[selfId];
    if (selfPlayer?.technologies.includes("valkyrie_particle_weave" as never) && (result.hitsScoredByPlayer[opponentId] ?? 0) > 0) {
      pendingHits[opponentId] = (pendingHits[opponentId] ?? 0) + 1;
    }
  }

  const round = pending.combatRound ?? 1;
  const updatedPending = maybeQueueCrownOfThalnosReroll(workingState, { ...pending, combatRound: round, pendingHits }, result.missedDiceByPlayerAndType);
  let nextState: GameState = { ...workingState, pendingTacticalAction: updatedPending };
  const events: GameEvent[] = [
    { type: "COMBAT_ROUND_RESOLVED", systemId, planetId, round, hitsScoredByPlayer: result.hitsScoredByPlayer },
  ];

  if (Object.keys(pendingHits).length === 0 && (updatedPending.crownOfThalnosPendingPlayers ?? []).length === 0) {
    const wrap = wrapUpGroundCombat(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }
  return { ok: true, state: nextState, events };
}

/** TE COEXIST: "If a player's coexisting units become the only units on a planet, that player gains control of the planet." Checked after anything that could reduce one of the 2 coexisting parties' units to zero (bombardment hit assignment, ground combat, etc.) — a no-op if this planet isn't actually in a coexisting state, or if both parties still have units present. */
function resolveSoleCoexistSurvivorControl(planet: PlanetState): PlanetState {
  const coexistingPlayerIds = planet.coexistingPlayerIds ?? [];
  if (coexistingPlayerIds.length === 0 || !planet.controllerId) return planet;
  const hasUnits = (playerId: PlayerId) => (planet.unitsByPlayer[playerId] ?? []).some((s) => s.count > 0);
  const allParties = [planet.controllerId, ...coexistingPlayerIds];
  const survivors = allParties.filter(hasUnits);
  if (survivors.length !== 1) return planet; // 2+ parties (still coexisting) or 0 (nobody left to hold it) — either way, no control change here
  const survivorId = survivors[0];
  return { ...planet, controllerId: survivorId, coexistingPlayerIds: undefined };
}

/**
 * TE COEXIST: "A coexisting player may choose to end their coexistence by
 * activating the coexisting unit's system and committing the coexisting
 * units against the planet they are coexisting on. If they win the
 * ground combat, they cease coexisting and gain control of the planet
 * as normal." Unlike a normal COMMIT_GROUND_FORCES, these units are
 * already ON the planet (as coexisting forces), not in the space area —
 * so this is its own action rather than reusing that one, and just
 * queues the SAME ground-combat machinery every other contested planet
 * already goes through (resolveGroundCombatRound, assignGroundCombatHits,
 * wrapUpGroundCombat), starting from this player's own tactical action
 * once it's reached the invasion step normally (their units don't need
 * to physically move, but the rest of that step's own gating — priority
 * windows, Mecatol custodians, etc. — still applies the same as always).
 */
/**
 * TE COEXIST (yjmrobert.com/tirules/rules/r_coexistence, rules 7 & 8):
 * either side of a coexistence can choose to start a REAL ground combat
 * instead of leaving things as they are — the controller against a
 * coexisting player, or a coexisting player against the controller. Both
 * directions reuse this SAME action/function; which one applies is
 * determined by whether the caller is the controller or one of the
 * coexisting players. `targetPlayerId` is only required when the
 * CONTROLLER is the one attacking and there's more than 1 coexisting
 * party to choose from (a coexisting player attacking always has exactly
 * 1 possible target: the controller).
 *
 * KNOWN SIMPLIFICATION: if a 3rd (or 4th...) party is ALSO coexisting on
 * this same planet but isn't part of THIS specific combat, this
 * project's existing ground-combat machinery (playersWithGroundForces,
 * which just looks at who has units present) doesn't yet exclude them
 * from getting pulled into the fight the way the rule's own pairwise
 * "start A ground combat" framing implies. Rule 10's own "start an
 * ADDITIONAL ground combat against ANOTHER coexisting player" after
 * winning is supported at the state-transition level (nothing blocks
 * calling this again once the current one resolves, targeting a
 * different remaining party) — but isolating simultaneous bystanders
 * from a 2-party fight would need a deeper change to the shared combat
 * pipeline than this pass makes; flagged rather than silently assumed.
 */
export function initiateCoexistCombat(state: GameState, action: { type: "INITIATE_COEXIST_COMBAT"; playerId: PlayerId; planetId: PlanetId; targetPlayerId?: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "invasion") {
    return { ok: false, error: "RR 44.2/TE COEXIST: no invasion step in progress for this player." };
  }
  if (pending.currentInvasionPlanetId || (pending.pendingHits && Object.keys(pending.pendingHits).length > 0)) {
    return { ok: false, error: "RR 44.2: resolve the current pending hits before starting another ground combat." };
  }
  const system = state.systems[pending.systemId];
  const planet = system?.planets.find((p) => p.planetId === action.planetId);
  if (!planet) return { ok: false, error: `No planet ${action.planetId}.` };

  const coexistingIds = planet.coexistingPlayerIds ?? [];
  const isCoexistingAttacker = coexistingIds.includes(action.playerId);
  const isControllerAttacker = planet.controllerId === action.playerId;
  if (!isCoexistingAttacker && !isControllerAttacker) {
    return { ok: false, error: "TE COEXIST: this player is neither the controller nor a coexisting player on that planet." };
  }

  let targetId: PlayerId;
  if (isCoexistingAttacker) {
    // Rule 8: a coexisting player attacking always targets the controller — there's no other option.
    if (!planet.controllerId) return { ok: false, error: "That planet has no controller to attack." };
    targetId = planet.controllerId;
  } else {
    // Rule 7: the controller attacking must choose WHICH coexisting party, if there's more than 1.
    if (coexistingIds.length === 0) return { ok: false, error: "No coexisting player on that planet to attack." };
    if (coexistingIds.length === 1) {
      targetId = coexistingIds[0];
    } else {
      if (!action.targetPlayerId || !coexistingIds.includes(action.targetPlayerId)) {
        return { ok: false, error: "TE COEXIST: multiple coexisting players present — targetPlayerId must specify which one to attack." };
      }
      targetId = action.targetPlayerId;
    }
  }

  const nextState: GameState = {
    ...state,
    pendingTacticalAction: {
      ...pending,
      invasionStepStarted: true,
      currentInvasionPlanetId: action.planetId,
      groundCombatParticipantIds: [action.playerId, targetId],
      pendingHits: {},
    },
  };
  return {
    ok: true,
    state: nextState,
    events: [{ type: "COEXISTENCE_ENDED_BY_ATTACK", systemId: pending.systemId, planetId: action.planetId, attackingPlayerId: action.playerId, targetPlayerId: targetId }],
  };
}

export function assignGroundCombatHits(
  state: GameState,
  action: { type: "ASSIGN_HITS"; playerId: PlayerId; assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[]; specOpsRespawnDieRolls?: number[] },
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

  // TE NEUTRAL UNITS: no real neutral player exists to submit this action
  // or make the normal free choice of which units absorb hits — the
  // fixed reference-card priority order (computeNeutralHitAssignments) is
  // used instead, regardless of whatever assignments the actual caller
  // (necessarily some OTHER real player, since neutral units can't submit
  // actions themselves) may have passed in.
  const groundAssignments = action.playerId === NEUTRAL_PLAYER_ID ? computeNeutralHitAssignments(stacks, hitsOwed, hasEntropicScar(system.anomalies)) : action.assignments;

  const result = applyHitAssignments(state, stacks, groundAssignments, hitsOwed, player.factionId, player.unitUpgrades, rules, system.anomalies, undefined, player.technologies.includes("non_euclidean_shielding" as never));
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
  // TE COEXIST: if this hit assignment just wiped out one of the 2
  // coexisting parties entirely, the survivor gains sole control of the
  // planet — coexistence itself is over (only 1 party's units remain).
  const coexistResolvedPlanet = resolveSoleCoexistSurvivorControl(updatedPlanet);
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? coexistResolvedPlanet : p)),
  };

  const remainingPendingHits = { ...pending.pendingHits };
  delete remainingPendingHits[action.playerId];

  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    players: { ...state.players, [action.playerId]: applySelfAssemblyRoutinesMechBonus(player, result.destroyed) },
    pendingTacticalAction: { ...pending, pendingHits: remainingPendingHits },
  };

  // Sol "Spec Ops II" (RESPAWN): checked for whichever of this player's own infantry were just destroyed here.
  const destroyedInfantryCount = result.destroyed.get("infantry") ?? 0;
  if (destroyedInfantryCount > 0 && action.specOpsRespawnDieRolls) {
    nextState = checkSpecOpsRespawn(nextState, action.playerId, destroyedInfantryCount, action.specOpsRespawnDieRolls, rules);
    // Arborec "Letani Warrior II" (Respawn): same mechanic as Sol's own Spec Ops II above, just its own faction gate and a 6+ threshold instead of 5+ — see rules/sol.ts's own checkSpecOpsRespawn, now generalized to take both as parameters.
    nextState = checkSpecOpsRespawn(nextState, action.playerId, destroyedInfantryCount, action.specOpsRespawnDieRolls, rules, "arborec", 6);
    // Generic Infantry II (any faction OTHER than Sol/Arborec, who have their own faction-specific replacement instead): same "roll 1 die per destroyed infantry, 6+ respawns" mechanic. Passing this player's own factionId makes checkSpecOpsRespawn's internal "player.factionId !== factionId" gate a tautology (always passes for them specifically) — the REAL gate that matters is still its own getUnitStats/"respawn" ability check, which only succeeds if this player's actual effective infantry has Respawn (i.e. they researched generic Infantry II). Guarded to skip Sol/Arborec explicitly so their own already-matched call above isn't redundantly re-applied to the same die rolls a second time.
    if (player.factionId !== ("sol" as never) && player.factionId !== ("arborec" as never)) {
      nextState = checkSpecOpsRespawn(nextState, action.playerId, destroyedInfantryCount, action.specOpsRespawnDieRolls, rules, player.factionId, 6);
    }
  }

  // Sardakk N'orr "Valkyrie Exoskeleton" (mech, Retaliation Strike): "After this unit uses its SUSTAIN DAMAGE ability during Ground Combat, it produces 1 hit against your opponent's ground forces on this planet." Confirmed (tirules2.com/F_norr): mandatory — 1 hit per mech that actually flipped this round, added to the OPPONENT's own pendingHits for this same combat (they'll need their own ASSIGN_HITS to resolve it, same as any other pending hit).
  const flippedMechs = result.flipped.get("mech") ?? 0;
  if (flippedMechs > 0 && player.factionId === ("sardakk" as never)) {
    const opponentId = playersWithGroundForces(planet).find((id) => id !== action.playerId);
    if (opponentId) {
      const updatedPending = nextState.pendingTacticalAction!;
      nextState = {
        ...nextState,
        pendingTacticalAction: { ...updatedPending, pendingHits: { ...updatedPending.pendingHits, [opponentId]: (updatedPending.pendingHits?.[opponentId] ?? 0) + flippedMechs } },
      };
    }
  }

  if (Object.keys(nextState.pendingTacticalAction!.pendingHits ?? {}).length === 0 && (pending.crownOfThalnosPendingPlayers ?? []).length === 0) {
    const wrap = wrapUpGroundCombat(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }
  return { ok: true, state: nextState, events };
}

// --- helpers ---------------------------------------------------------------

/** RR "Magen Defense Grid": which version (if any) this defender qualifies for on this planet, given their own owned/readied state and what's physically there. Returns null if they don't own it, or don't meet either version's own physical requirement. */
function checkMagenDefenseGridEligibility(state: GameState, rules: RuleData, defenderId: PlayerId, planet: PlanetState, attackerId: PlayerId, systemId: SystemId): "base" | "omega_omega" | null {
  const player = state.players[defenderId];
  const techId = asTechId("magen_defense_grid");
  if (!player.technologies.includes(techId)) return null;

  if (usesCodex4Version(state.mode)) {
    // ΩΩ: not exhaustable, needs 1+ structures (not specifically Planetary Shield) on this planet.
    const hasStructure = (planet.unitsByPlayer[defenderId] ?? []).some((s) => STRUCTURE_TYPES.includes(s.unitType) && s.count > 0);
    return hasStructure ? "omega_omega" : null;
  }

  // Base: must be readied, needs 1+ Planetary-Shield-capable units on this
  // planet. RR 65.3/65.3b: if the ATTACKER has a war sun in this system,
  // Planetary Shield (and therefore this base version of Magen Defense
  // Grid, which depends on it) is negated entirely — previously unchecked.
  if (player.exhaustedTechnologies.includes(techId)) return null;
  const attackerHasWarSunInSystem = (state.systems[systemId]?.spaceUnitsByPlayer[attackerId] ?? []).some((s) => s.unitType === "war_sun" && s.count > 0);
  // Letnev "Arc Secundus" (flagship): "Other players' units in this system lose PLANETARY SHIELD." Confirmed (yjmrobert.com/tirules/factions/f_letnev): if this results in NO unit on the planet having Planetary Shield, the base Magen Defense Grid can't be used there either — same negation shape as the war sun above, and likewise has "no effect on Magen Defense Grid Ω or ΩΩ" (both already return earlier, before this base-only branch is ever reached).
  const attackerHasArcSecundusInSystem = (state.systems[systemId]?.spaceUnitsByPlayer[attackerId] ?? []).some((s) => s.unitType === "flagship" && s.count > 0 && state.players[attackerId]?.factionId === ("letnev" as never));
  if (attackerHasWarSunInSystem || attackerHasArcSecundusInSystem) return null;
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

  // TE COEXIST (yjmrobert.com/tirules/rules/r_coexistence): a 3rd (or
  // more) coexisting party can be present on this SAME planet without
  // being part of THIS combat — playersWithGroundForces would count them
  // too, wrongly reading "both sides still standing" forever whenever a
  // bystander happens to have units here. groundCombatParticipantIds (set
  // by whichever of startGroundCombat/initiateCoexistCombat began this
  // specific fight) is the reliable source for "who was actually
  // fighting", both for Shard of the Throne's own check and for deciding
  // whether this fight itself has ended.
  const participantIds = pending.groundCombatParticipantIds ?? (Object.keys(planet.unitsByPlayer) as PlayerId[]);
  const combatantsBeforeEnd = participantIds;
  const survivors = participantIds.filter((id) => (planet.unitsByPlayer[id] ?? []).some((s) => s.count > 0));
  const events: GameEvent[] = [];
  let nextState = state;

  if (survivors.length <= 1) {
    const winner = survivors[0] ?? null;
    const previousControllerId = planet.controllerId;
    if (winner) {
      const controlResult = setPlanetController(nextState, systemId, planetId, winner, rules, pending.dualTraitChoices?.[planetId], pending.pendingExplorationChoices?.[planetId]);
      nextState = controlResult.state;
      events.push(...controlResult.events, { type: "PLANET_CONTROL_ESTABLISHED", systemId, planetId, playerId: winner });
      // TE COEXIST: this fight's own loser is out, and if the winner was
      // previously one of the coexisting parties (not the controller),
      // they're now the controller instead — remove BOTH from
      // coexistingPlayerIds so the list only ever reflects genuine
      // bystanders untouched by this fight, never the fight's own 2
      // participants under their new roles.
      const updatedPlanetForBystanders = system.planets.find((p) => p.planetId === planetId)!;
      const loserId = participantIds.find((id) => id !== winner);
      const staleIds = [loserId, winner].filter((id): id is PlayerId => id !== null && id !== undefined);
      if ((updatedPlanetForBystanders.coexistingPlayerIds ?? []).some((id) => staleIds.includes(id))) {
        const clearedBystanderPlanet: PlanetState = {
          ...updatedPlanetForBystanders,
          coexistingPlayerIds: (updatedPlanetForBystanders.coexistingPlayerIds ?? []).filter((id) => !staleIds.includes(id)),
        };
        const clearedSystem: SystemState = { ...nextState.systems[systemId], planets: nextState.systems[systemId].planets.map((p) => (p.planetId === planetId ? clearedBystanderPlanet : p)) };
        nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: clearedSystem } };
      }
    }
    events.push({ type: "GROUND_COMBAT_ENDED", systemId, planetId, survivingPlayerId: winner });

    // RR "Infiltrate"/"Reparations": same window commitGroundForces' own uncontested-landing branch opens.
    if (winner && previousControllerId !== winner) {
      const controlParticipants = [winner, ...(previousControllerId && !nextState.players[previousControllerId]?.eliminated ? [previousControllerId] : [])];
      const controlOrder = actionPhaseWindowOrder(nextState, pending.playerId, controlParticipants);
      if (controlOrder.length > 0) {
        return {
          state: { ...nextState, pendingPlanetControlGainedContinuation: "ground_combat_wrap_up", pendingPriorityWindow: { kind: "planet_control_gained", order: controlOrder, currentIndex: 0, consecutivePasses: 0 } },
          events,
        };
      }
    }
    return finishGroundCombatWrapUp(nextState, pending, systemId, events);
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
      // Letnev "Dunlain Reaper" (mech, DEPLOY): "once per timing window" — resets each new round, letting a fresh one be deployed.
      usedDunlainReaperDeployThisRound: false,
    },
  };
  return { state: openGroundCombatRoundStartWindowIfNeeded(nextState), events };
}

/** The queue/next-step tail of wrapUpGroundCombat's own "combat's over, someone (or no one) survived" branch — split out so GameEngine.ts can reach it once RR "Infiltrate"/"Reparations"' own "planet_control_gained" window closes, without re-running the control-establishment/Shard-of-the-Throne/GROUND_COMBAT_ENDED logic a second time. */
export function finishGroundCombatWrapUp(state: GameState, pending: NonNullable<GameState["pendingTacticalAction"]>, systemId: SystemId, events: GameEvent[]): { state: GameState; events: GameEvent[] } {
  const queue = pending.remainingInvasionPlanetIds ?? [];
  const nextState: GameState = {
    ...state,
    pendingTacticalAction:
      queue.length > 0
        ? { ...pending, currentInvasionPlanetId: undefined, combatRound: undefined, pendingHits: {} }
        : { playerId: pending.playerId, systemId, step: "production" },
  };
  return { state: nextState, events };
}

/** RR 25.1: gaining control of a planet ALWAYS exhausts its planet card — no exceptions, regardless of how control was gained (invasion win, uncontested landing, anything else). RR 53.2: a legendary planet's separate ability card only readies if this is the FIRST time it's ever been controlled (i.e. it's coming "from the deck"); if it's being taken FROM another player, it keeps whatever exhausted/readied state it already had — untouched here, on purpose. RR 25.1c: if the planet wasn't already controlled by ANOTHER player (i.e. this is genuinely the first time anyone's controlled it), the new controller explores it automatically — this used to only happen via the separate, player-initiated EXPLORE_PLANET action, which incorrectly made exploring a planet an optional extra step rather than an automatic consequence of gaining control. */
export function setPlanetController(
  state: GameState,
  systemId: SystemId,
  planetId: PlanetId,
  controllerId: PlayerId,
  rules: RuleData,
  /** TE DUAL PLANET TRAITS (rulebook p.11): the controlling player's own choice of which trait to explore with, if this planet has 2 — supplied by whichever action actually triggers this control gain (COMMIT_GROUND_FORCES for an uncontested landing, ASSIGN_HITS for a combat win), since that player already knows which planet is at stake when they submit it. Optional/ignored for single-trait (or traitless) planets. */
  chosenTrait?: "cultural" | "industrial" | "hazardous",
  /** Player choice for whatever exploration card gets drawn as part of this specific control gain, if it needs one — see phases/exploration.ts's own ExplorationCardChoice/applyExplorationCard. */
  explorationChoice?: import("./exploration").ExplorationCardChoice,
): { state: GameState; events: GameEvent[] } {
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId);
  if (!planet || planet.controllerId === controllerId) return { state, events: [] };

  const previousControllerId = planet.controllerId;
  const wasUncontrolled = previousControllerId === null;
  const isLegendary = rules.planets[planetId]?.isLegendary ?? false;

  const updatedPlanet: PlanetState = {
    ...planet,
    controllerId,
    exhausted: true,
    // RR 49.5b: any structures (PDS, space dock) belonging to OTHER
    // players are destroyed immediately when control changes hands —
    // previously untouched, meaning a captured planet kept the old
    // controller's PDS/space dock sitting there indefinitely.
    unitsByPlayer: Object.fromEntries(
      Object.entries(planet.unitsByPlayer).map(([pid, stacks]) =>
        pid === controllerId ? [pid, stacks] : [pid, (stacks ?? []).filter((s) => !STRUCTURE_TYPES.includes(s.unitType))],
      ),
    ),
    ...(wasUncontrolled && isLegendary ? { legendaryAbilityExhausted: false } : {}),
  };
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)),
  };
  let nextState: GameState = { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };

  // L1Z1X "ASSIMILATE" (faction ability): "When you gain control of a
  // planet, replace each PDS and space dock that is on that planet with
  // a matching unit from your reinforcements." Confirmed
  // (yjmrobert.com/tirules/factions/f_lizix):
  //  - Checked against whatever structures were on the planet BEFORE
  //    RR 49.5b's own destruction above already removed them (this
  //    project's own general rule for ANY other player's structures on
  //    control change) — Assimilate's own replacement is a consequence
  //    layered ON TOP of that normal destruction, not an exception to it.
  //  - Mandatory for every structure type that WAS there, unless there
  //    are none of that type left in reinforcements (not forced then).
  //  - If none left in reinforcements, may substitute from any OTHER
  //    system without this player's own command token (same "steal from
  //    elsewhere" fallback as Freelancers/Letani Ospha/Dirzuga Rophal).
  //  - A newly-placed space dock CAN produce during this SAME tactical
  //    action's own Production step — achieved simply by never gating
  //    or flagging it any differently from a normally-placed one.
  if (state.players[controllerId]?.factionId === ("l1z1x" as never) && previousControllerId && previousControllerId !== controllerId) {
    const destroyedStructureTypes = (planet.unitsByPlayer[previousControllerId] ?? []).filter((s) => STRUCTURE_TYPES.includes(s.unitType) && s.count > 0).map((s) => s.unitType);
    const pendingReplacements: { planetId: PlanetId; unitType: import("../types/enums").UnitType }[] = [...(nextState.players[controllerId]?.pendingAssimilateReplacements ?? [])];
    for (const structureType of destroyedStructureTypes) {
      const check = checkReinforcementsAvailable(nextState, controllerId, [{ unitType: structureType, count: 1 }]);
      if (check.ok) {
        const currentPlanet = nextState.systems[systemId].planets.find((p) => p.planetId === planetId)!;
        const stacks = currentPlanet.unitsByPlayer[controllerId] ?? [];
        const existing = stacks.find((s) => s.unitType === structureType);
        const updatedStacks = existing ? stacks.map((s) => (s.unitType === structureType ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: structureType, count: 1, damagedCount: 0 }];
        const finalPlanet: PlanetState = { ...currentPlanet, unitsByPlayer: { ...currentPlanet.unitsByPlayer, [controllerId]: updatedStacks } };
        nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...nextState.systems[systemId], planets: nextState.systems[systemId].planets.map((p) => (p.planetId === planetId ? finalPlanet : p)) } } };
      } else {
        // "Not forced if none left in reinforcements" — but per ruling #3, the player MAY still substitute from elsewhere later; queued here (rules/l1z1x.ts's own resolveAssimilateSubstitute) rather than silently dropped.
        pendingReplacements.push({ planetId, unitType: structureType });
      }
    }
    if (pendingReplacements.length > (nextState.players[controllerId]?.pendingAssimilateReplacements ?? []).length) {
      nextState = { ...nextState, players: { ...nextState.players, [controllerId]: { ...nextState.players[controllerId], pendingAssimilateReplacements: pendingReplacements } } };
    }
  }
  // L1Z1X "Fealty Uplink" (Breakthrough ability): "When you gain control of a planet, place infantry equal to that planet's influence value on that planet." Mandatory — see rules/l1z1x.ts's own applyFealtyUplink for the full doc comment.
  nextState = applyFealtyUplink(nextState, controllerId, systemId, planetId, rules);
  // RR "Shard of the Throne" (relic — PoK version, not the old base-game law): checked on every actual control change, not just combat wins — see rules/relics.ts's own doc comment for the full history/reasoning.
  nextState = maybeTransferShardOfTheThroneOnControlGain(nextState, controllerId, planetId, previousControllerId, rules);
  // Styx / "A Song Like Marrow" (Fracture legendary planet ability): "When you gain this card, gain 1 victory point. When you lose this card, lose 1 victory point." Simple, direct VP swing tied to control of this ONE specific planet — unlike Shard of the Throne, no broader "legendary or home system" condition to check, just this planet by name.
  if (planetId === ("styx" as never)) {
    if (previousControllerId) {
      const losingPlayer = nextState.players[previousControllerId];
      if (losingPlayer) {
        nextState = { ...nextState, players: { ...nextState.players, [previousControllerId]: { ...losingPlayer, victoryPoints: { ...losingPlayer.victoryPoints, current: Math.max(0, losingPlayer.victoryPoints.current - 1) } } } };
      }
    }
    const gainingPlayer = nextState.players[controllerId];
    nextState = { ...nextState, players: { ...nextState.players, [controllerId]: { ...gainingPlayer, victoryPoints: { ...gainingPlayer.victoryPoints, current: gainingPlayer.victoryPoints.current + 1 } } } };
  }
  const events: GameEvent[] = [];

  // RR 73/75: "When a player gains a planet card FROM THE PLANET DECK
  // that has a relic icon... they draw the top card of the relic deck."
  // "From the planet deck" specifically means this is the planet's
  // very first-ever control (RR 25.1a: only the FIRST controller ever
  // takes the card from the deck — every later control change takes it
  // from whichever player controlled it before instead) — so this is
  // gated on wasUncontrolled, same condition as RR 25.1c's own
  // exploration trigger below, not fired on every control change.
  // "If there are no cards in the relic deck, they do not gain a relic"
  // (RR 73.2a) — a no-op, not an error, if the deck's empty.
  if (wasUncontrolled && rules.planets[planetId]?.hasRelicIcon) {
    const relicDeck = nextState.relicDeck ?? [];
    if (relicDeck.length > 0) {
      const [relicId, ...restRelicDeck] = relicDeck;
      const gainingPlayer = nextState.players[controllerId];
      nextState = {
        ...nextState,
        relicDeck: restRelicDeck,
        players: { ...nextState.players, [controllerId]: { ...gainingPlayer, relics: [...gainingPlayer.relics, relicId] } },
      };
      events.push({ type: "RELIC_GAINED", playerId: controllerId, relicId });
      // Naalu Collective "Iconoclast ΩΩ" (mech, Deploy): "when another player gains a relic, place 1 mech" — see rules/naalu.ts's own applyIconoclastOmegaOmegaDeploy.
      nextState = applyIconoclastOmegaOmegaDeploy(nextState, controllerId);
      // Every relic's own "when you gain this card" trigger — see rules/relics.ts's own applyRelicOnGainEffects.
      const onGain = applyRelicOnGainEffects(nextState, controllerId, relicId, rules);
      nextState = onGain.state;
    }
  }

  // RR 25.1c: automatic exploration — only for a planet no one has EVER
  // controlled before (wasUncontrolled), only with PoK content, and only
  // if the planet actually has a trait to explore with (Mecatol Rex and
  // home-system planets have none, and can't be explored — same check
  // EXPLORE_PLANET itself already makes).
  if (wasUncontrolled && hasPoKContent(state.mode) && !updatedPlanet.explored) {
    // TE DUAL PLANET TRAITS: the controlling player already knows, at the
    // moment they submit the action that gains this control, which
    // planet is at stake — so their own chosenTrait (passed in above)
    // decides which of the 2 traits to explore with, same choice
    // explorePlanet/playArchaeologicalExpedition already require.
    const traits = (rules.planets[planetId]?.traits ?? []) as ("cultural" | "industrial" | "hazardous")[];
    const trait = traits.length === 1 ? traits[0] : traits.length > 1 && chosenTrait && traits.includes(chosenTrait) ? chosenTrait : undefined;
    if (trait) {
      const deck = nextState.explorationDecks?.[trait] ?? [];
      if (deck.length > 0) {
        const [cardId, ...rest] = deck;
        const result = applyExplorationCard(nextState, controllerId, systemId, planetId, cardId, rules, explorationChoice);
        nextState = result.state;
        events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: controllerId, cardId, deck: trait });
        // RR "exploration": "if the card was not a relic fragment or an attachment, it is discarded" (and see rules/exploration.ts's own applyExplorationCard doc comment for the further "or purged" case) — previously this specific path (exploring via gaining planet control) never tracked a discard pile at all, unlike frontier-token exploration's own equivalent path.
        const card = rules.explorationCards[cardId];
        const goesToDiscard = !card?.isRelicFragment && !card?.attach && !card?.keepInPlayArea && !card?.purge;
        nextState = {
          ...nextState,
          explorationDecks: { ...nextState.explorationDecks!, [trait]: rest },
          explorationDiscardPiles: { ...nextState.explorationDiscardPiles, [trait]: goesToDiscard ? [...(nextState.explorationDiscardPiles?.[trait] ?? []), cardId] : (nextState.explorationDiscardPiles?.[trait] ?? []) } as GameState["explorationDiscardPiles"],
        };
      }
      const exploredSystem = nextState.systems[systemId];
      nextState = {
        ...nextState,
        systems: { ...nextState.systems, [systemId]: { ...exploredSystem, planets: exploredSystem.planets.map((p) => (p.planetId === planetId ? { ...p, explored: true } : p)) } },
      };
    }
  }

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

  // RR PoK "Wormhole Nexus": gaining control of Mallice is the OTHER trigger for the active-flip (the first being a ship arriving there — see tacticalAction.ts's moveShips).
  return { state: maybeActivateWormholeNexus(nextState, rules, systemId), events };
}
