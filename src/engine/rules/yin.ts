import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asTechId } from "../types/ids";
import { GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { exhaustPlanetsForInfluence } from "../phases/strategyCardAbilities";
import { checkReinforcementsAvailable } from "./reinforcements";
import { unlockCommander } from "./leaders";
import { hasCodex } from "./gameMode";
import { setPlanetController, wrapUpGroundCombat } from "../phases/invasion";
import { wrapUpCombatRound } from "../phases/spaceCombat";

/** Yin Brotherhood "Brother Omar" (commander): "The faction abilities to unlock Brother Omar are Indoctrination or Devotion." Confirmed (yjmrobert.com/tirules/factions/f_yin) — shared by both useIndoctrination and useDevotion below, right after each one's own effect actually resolves. */
function maybeUnlockBrotherOmar(state: GameState, playerId: PlayerId): GameState {
  const player = state.players[playerId];
  if (player.factionId !== ("yin" as never)) return state;
  const entry = player.leaders.find((l) => l.leaderId === ("yin_commander" as never));
  if (!entry || !entry.locked) return state;
  return { ...state, players: { ...state.players, [playerId]: unlockCommander(player, "yin_commander" as never) } };
}

/**
 * Yin Brotherhood "INDOCTRINATION" (faction ability): "At the start of a
 * ground combat, you may spend 2 influence to replace 1 of your
 * opponent's participating infantry with 1 infantry from your
 * reinforcements." Confirmed (yjmrobert.com/tirules/factions/f_yin):
 * "limited to once per ground combat" (tracked here via
 * pendingTacticalAction.usedIndoctrinationForPlanetId, naturally reset
 * whenever a NEW ground combat starts on a different planet — see
 * phases/invasion.ts's own startGroundCombat); "if an invasion involves
 * ground combats on multiple planets, Indoctrination may be used at the
 * start of EACH of them"; "cannot be used if the opponent only has
 * mechs"; "if the last of a player's ground forces are removed by
 * Indoctrination, that player loses the combat immediately — they will
 * be unable to use any 'start of combat' abilities" (this last part —
 * an instant loss bypassing further start-of-combat windows — isn't
 * separately implemented here; flagged, since this project's own ground
 * combat resolution doesn't currently have a single well-defined
 * "instant loss" short-circuit to hook into cleanly).
 *
 * Yin "Moyin's Ashes" (mech, Deploy): "you may spend 1 additional
 * influence to replace your opponent's unit with 1 mech instead of 1
 * infantry" — folded into this SAME function via `useMechInstead`,
 * rather than a separate action, since it's the exact same trigger and
 * timing, just a costlier variant of the same replacement. Confirmed
 * (yjmrobert.com/tirules/factions/f_yin): "the removed unit must still
 * be an infantry" (i.e. this Deploy can't be combined with somehow
 * targeting a mech) and "the Deploy ability has a total cost of 3
 * influence" (2 for Indoctrination itself + 1 more) — matching
 * `useMechInstead`'s own +1 addition here. "If all four Moyin's Ashes
 * are already on the board, no more may be deployed" — this project's
 * own checkReinforcementsAvailable already enforces that generically
 * (a player only ever owns as many mech tokens as their box provides).
 */
export function useIndoctrination(
  state: GameState,
  action: { type: "USE_INDOCTRINATION"; playerId: PlayerId; exhaustPlanetIdsForInfluence: PlanetId[]; useMechInstead?: boolean },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "Indoctrination: no ground combat is currently in progress for this player." };
  }
  if (pending.yinFactionAbilitiesBannedThisAction) {
    return { ok: false, error: 'Greyfire Mutagen: this player cannot use faction abilities during this tactical action.' };
  }
  const planetId = pending.currentInvasionPlanetId;
  if (pending.usedIndoctrinationForPlanetId === planetId) {
    return { ok: false, error: "Indoctrination has already been used for this ground combat." };
  }
  const opponentId = pending.groundCombatParticipantIds?.find((id) => id !== action.playerId);
  if (!opponentId) return { ok: false, error: "Indoctrination: no opponent in this ground combat." };

  const system = state.systems[pending.systemId];
  const planet = system.planets.find((p) => p.planetId === planetId)!;
  const opponentStacks = planet.unitsByPlayer[opponentId] ?? [];
  const opponentInfantry = opponentStacks.find((s) => s.unitType === "infantry" && s.count > 0);
  if (!opponentInfantry) {
    return { ok: false, error: "Indoctrination: the opponent has no participating infantry (mechs alone don't qualify)." };
  }

  const cost = action.useMechInstead ? 3 : 2;
  if (action.useMechInstead) {
    const player = state.players[action.playerId];
    if (player.factionId !== ("yin" as never)) return { ok: false, error: "Only the Yin player has Moyin's Ashes." };
  }
  const spend = exhaustPlanetsForInfluence(state, action.playerId, action.exhaustPlanetIdsForInfluence, rules);
  if (!spend.ok) return spend;
  if (spend.influence < cost) return { ok: false, error: `Indoctrination: need ${cost} influence, got ${spend.influence}.` };

  const replacementUnitType = action.useMechInstead ? "mech" : "infantry";
  const reinforcementsCheck = checkReinforcementsAvailable(spend.state, action.playerId, [{ unitType: replacementUnitType, count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const updatedOpponentStacks = opponentStacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const ownStacks = (planet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  const existingOwn = ownStacks.find((s) => s.unitType === replacementUnitType && !s.upgradeId);
  if (existingOwn) existingOwn.count += 1;
  else ownStacks.push({ unitType: replacementUnitType, count: 1, damagedCount: 0 });

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [opponentId]: updatedOpponentStacks, [action.playerId]: ownStacks } };
  const nextState: GameState = {
    ...spend.state,
    systems: { ...spend.state.systems, [pending.systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } },
    pendingTacticalAction: { ...spend.state.pendingTacticalAction!, usedIndoctrinationForPlanetId: planetId },
  };
  return { ok: true, state: maybeUnlockBrotherOmar(nextState, action.playerId), events: [] };
}

/**
 * Yin Brotherhood "DEVOTION" (faction ability): "After each space battle
 * round, you may destroy 1 of your cruisers or destroyers in the active
 * system to produce 1 hit and assign it to 1 of your opponent's ships
 * in that system." Confirmed (yjmrobert.com/tirules/factions/f_yin):
 * "the Yin player chooses which ship is assigned the hit" (never their
 * own ships); "the targeted ship may cancel the hit with Sustain
 * Damage, if present"; "unusable if the opponent retreated" (no ships
 * left there — checked here by requiring the target actually be
 * present). Sustain Damage cancellation is handled the SAME way
 * ordinary combat hits already are — this just produces 1 hit and lets
 * the normal hit-assignment/Sustain-Damage machinery apply it, rather
 * than duplicating that logic here.
 */
export function useDevotion(
  state: GameState,
  action: { type: "USE_DEVOTION"; playerId: PlayerId; sacrificeUnitType: "cruiser" | "destroyer"; targetPlayerId: PlayerId; targetUnitType: import("../types/enums").UnitType; targetIsDamaged?: boolean },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "spaceCombat") {
    return { ok: false, error: "Devotion is only usable right after a space combat round, during this player's own tactical action." };
  }
  if (pending.yinFactionAbilitiesBannedThisAction) {
    return { ok: false, error: 'Greyfire Mutagen: this player cannot use faction abilities during this tactical action.' };
  }
  if (action.targetPlayerId === action.playerId) return { ok: false, error: "Devotion cannot target this player's own ships." };
  const system = state.systems[pending.systemId];
  const ownStacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const sacrificeStack = ownStacks.find((s) => s.unitType === action.sacrificeUnitType && s.count > 0);
  if (!sacrificeStack) return { ok: false, error: `This player has no ${action.sacrificeUnitType} in ${pending.systemId} to sacrifice.` };
  const targetStacks = system.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
  const targetStack = targetStacks.find((s) => s.unitType === action.targetUnitType && s.count > 0);
  if (!targetStack) return { ok: false, error: `The target has no ${action.targetUnitType} in ${pending.systemId}.` };

  const targetStats = getUnitStats(rules, state.players[action.targetPlayerId].factionId, action.targetUnitType, state.players[action.targetPlayerId].unitUpgrades);
  const canSustain = targetStats?.abilities.includes("sustainDamage") && (targetStack.damagedCount ?? 0) < targetStack.count;
  let updatedTargetStacks = targetStacks;
  if (canSustain && action.targetIsDamaged) {
    updatedTargetStacks = targetStacks.map((s) => (s === targetStack ? { ...s, damagedCount: (s.damagedCount ?? 0) + 1 } : s));
  } else {
    updatedTargetStacks = targetStacks.map((s) => (s === targetStack ? { ...s, count: s.count - 1, damagedCount: Math.min(s.damagedCount ?? 0, s.count - 1) } : s)).filter((s) => s.count > 0);
  }

  const updatedOwnStacks = ownStacks.map((s) => (s === sacrificeStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedOwnStacks, [action.targetPlayerId]: updatedTargetStacks },
  };
  return {
    ok: true,
    state: maybeUnlockBrotherOmar({ ...state, systems: { ...state.systems, [pending.systemId]: updatedSystem } }, action.playerId),
    events: [{ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: pending.systemId, unitType: action.sacrificeUnitType, count: 1 }],
  };
}

/**
 * Yin Brotherhood "Impulse Core" (faction technology): "At the start of
 * a space combat, you may destroy 1 of your cruisers or destroyers in
 * the active system to produce 1 hit against your opponent's ships;
 * that hit must be assigned by your opponent to 1 of their non-fighter
 * ships, if able." Confirmed (yjmrobert.com/tirules/factions/f_yin):
 * "the Yin player's OPPONENT chooses which ship is assigned the hit"
 * (the reverse of Devotion's own targeting, hence a separate
 * `chosenByOpponentUnitType` parameter rather than reusing useDevotion);
 * "resolves BEFORE the Anti-Fighter Barrage step" (so a destroyer killed
 * this way never gets to make its own AFB roll — this project's own
 * combat sequencing already places USE_IMPULSE_CORE's own call before
 * AFB, since nothing else currently opens an earlier window).
 */
/**
 * Yin Brotherhood "Impulse Core" (faction technology): "At the start of
 * a space combat, you may destroy 1 of your cruisers or destroyers in
 * the active system to produce 1 hit against your opponent's ships;
 * that hit must be assigned by your opponent to 1 of their non-fighter
 * ships, if able." CORRECTED (yjmrobert.com/tirules/factions/f_yin):
 * "the Yin player's OPPONENT chooses which ship is assigned the hit" —
 * an earlier version of this function incorrectly let the YIN player
 * choose the target directly (copy-pasted from Devotion's own OPPOSITE
 * rule, where Yin genuinely does choose). Split into 2 steps to match:
 * this one only sacrifices the ship and queues the hit
 * (pendingImpulseCoreHitAssignment), Yin's opponent then resolves WHERE
 * it lands via assignImpulseCoreHit below. "Resolves BEFORE the
 * Anti-Fighter Barrage step" (so a destroyed destroyer never gets its
 * own AFB roll) relies on the caller invoking this before AFB
 * resolves — not independently re-verified here beyond "still round 1"
 * the same way it wasn't before.
 */
export function useImpulseCore(
  state: GameState,
  action: { type: "USE_IMPULSE_CORE"; playerId: PlayerId; sacrificeUnitType: "cruiser" | "destroyer" },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("yin" as never) || !player.technologies.includes(asTechId("impulse_core"))) {
    return { ok: false, error: "This player doesn't have Impulse Core." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "spaceCombat" || (pending.combatRound ?? 0) > 1 || pending.usedImpulseCoreThisCombat) {
    return { ok: false, error: "Impulse Core is only usable once, at the start of a space combat, before the first round resolves." };
  }
  if (pending.yinFactionAbilitiesBannedThisAction) {
    return { ok: false, error: 'Greyfire Mutagen: this player cannot use faction technology during this tactical action.' };
  }
  const system = state.systems[pending.systemId];
  const ownStacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const sacrificeStack = ownStacks.find((s) => s.unitType === action.sacrificeUnitType && s.count > 0);
  if (!sacrificeStack) return { ok: false, error: `This player has no ${action.sacrificeUnitType} in ${pending.systemId} to sacrifice.` };
  const opponentId = Object.keys(system.spaceUnitsByPlayer).find((pid) => pid !== action.playerId && (system.spaceUnitsByPlayer[pid as PlayerId] ?? []).some((s) => s.count > 0)) as PlayerId | undefined;
  if (!opponentId) return { ok: false, error: "Impulse Core: no opponent ships present to hit." };

  const updatedOwnStacks = ownStacks.map((s) => (s === sacrificeStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedOwnStacks } };
  return {
    ok: true,
    state: {
      ...state,
      systems: { ...state.systems, [pending.systemId]: updatedSystem },
      pendingTacticalAction: { ...pending, usedImpulseCoreThisCombat: true, pendingImpulseCoreHitAssignment: { opponentId, systemId: pending.systemId } },
    },
    events: [{ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: pending.systemId, unitType: action.sacrificeUnitType, count: 1 }],
  };
}

/** Yin Brotherhood "Impulse Core": the opponent's own hit-assignment half — see useImpulseCore's own doc comment above. */
export function assignImpulseCoreHit(
  state: GameState,
  action: { type: "ASSIGN_IMPULSE_CORE_HIT"; playerId: PlayerId; targetUnitType: import("../types/enums").UnitType; targetIsDamaged?: boolean },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  const offer = pending?.pendingImpulseCoreHitAssignment;
  if (!offer || offer.opponentId !== action.playerId) return { ok: false, error: "No pending Impulse Core hit to assign." };

  const system = state.systems[offer.systemId];
  const targetStacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const targetStack = targetStacks.find((s) => s.unitType === action.targetUnitType && s.count > 0);
  if (!targetStack) return { ok: false, error: `This player has no ${action.targetUnitType} in ${offer.systemId}.` };
  if (action.targetUnitType === "fighter" && targetStacks.some((s) => s.unitType !== "fighter" && s.count > 0)) {
    return { ok: false, error: "Impulse Core: this hit must be assigned to a non-fighter ship if this player has one." };
  }

  const targetStats = getUnitStats(rules, state.players[action.playerId].factionId, action.targetUnitType, state.players[action.playerId].unitUpgrades);
  const canSustain = targetStats?.abilities.includes("sustainDamage") && (targetStack.damagedCount ?? 0) < targetStack.count;
  let updatedTargetStacks = targetStacks;
  if (canSustain && action.targetIsDamaged) {
    updatedTargetStacks = targetStacks.map((s) => (s === targetStack ? { ...s, damagedCount: (s.damagedCount ?? 0) + 1 } : s));
  } else {
    updatedTargetStacks = targetStacks.map((s) => (s === targetStack ? { ...s, count: s.count - 1, damagedCount: Math.min(s.damagedCount ?? 0, s.count - 1) } : s)).filter((s) => s.count > 0);
  }
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedTargetStacks } };
  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [offer.systemId]: updatedSystem }, pendingTacticalAction: { ...pending!, pendingImpulseCoreHitAssignment: undefined } },
    events: [],
  };
}

/**
 * Yin Brotherhood "Greyfire Mutagen" (promissory note, original): "After
 * a system is activated: The Yin player cannot use faction abilities or
 * faction technology during this tactical action. Then, return this
 * card to the Yin player." Confirmed (yjmrobert.com/tirules/factions/f_yin):
 * "leader abilities, mech abilities and flagship abilities are NOT
 * faction abilities" — so this does NOT block Brother Milor, Brother
 * Omar, Daneel of the Tenth, Moyin's Ashes' own Deploy, or Van Hauge's
 * Martyrdom; it only blocks INDOCTRINATION/DEVOTION and Impulse
 * Core/Yin Spinner (the 2 faction techs). Modeled as a per-tactical-
 * action ban flag rather than trying to gate each of those 4 functions
 * individually with a duplicated check.
 */
export function usePlayGreyfireMutagen(
  state: GameState,
  action: { type: "USE_PLAY_GREYFIRE_MUTAGEN"; playerId: PlayerId; targetSystemId: SystemId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.promissoryNotesInHand.includes("yin_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Greyfire Mutagen in hand." };
  }
  const yinId = Object.values(state.players).find((p) => p.factionId === ("yin" as never))?.id;
  if (!yinId) return { ok: false, error: "No Yin player in this game." };
  if (!state.pendingTacticalAction || state.pendingTacticalAction.playerId !== yinId || state.pendingTacticalAction.systemId !== action.targetSystemId) {
    return { ok: false, error: "Greyfire Mutagen: only usable right after the Yin player activates this system." };
  }

  const updatedPlayer: Player = { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("yin_promissory" as never)) };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, pendingTacticalAction: { ...state.pendingTacticalAction, yinFactionAbilitiesBannedThisAction: true } },
    events: [],
  };
}

/**
 * Yin Brotherhood "Greyfire Mutagen Ω" (promissory note, codex): "At the
 * start of a ground combat against 2 or more ground forces that are not
 * controlled by the Yin player: Replace 1 of your opponent's infantry
 * with 1 infantry from your reinforcements. Then, return this card to
 * the Yin player." Confirmed (yjmrobert.com/tirules/factions/f_yin):
 * usable by whoever holds it (not necessarily Yin), targeting THEIR OWN
 * ground combat (against a 3rd party, not Yin) — an independent,
 * "borrowed Indoctrination" effect, never touching Yin's own
 * usedIndoctrinationForPlanetId tracking. "2 or more ground forces" is
 * a combined count across all unit types, not specifically 2+ infantry.
 */
export function usePlayGreyfireMutagenOmega(
  state: GameState,
  action: { type: "USE_PLAY_GREYFIRE_MUTAGEN_OMEGA"; playerId: PlayerId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.promissoryNotesInHand.includes("yin_promissory_omega" as never)) {
    return { ok: false, error: "This player doesn't have Greyfire Mutagen Ω in hand." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "Greyfire Mutagen Ω: no ground combat is currently in progress for this player." };
  }
  const opponentId = pending.groundCombatParticipantIds?.find((id) => id !== action.playerId);
  if (!opponentId) return { ok: false, error: "Greyfire Mutagen Ω: no opponent in this ground combat." };

  const system = state.systems[pending.systemId];
  const planet = system.planets.find((p) => p.planetId === pending.currentInvasionPlanetId)!;
  const opponentStacks = planet.unitsByPlayer[opponentId] ?? [];
  const opponentGroundForceCount = opponentStacks.filter((s) => GROUND_FORCE_TYPES.includes(s.unitType)).reduce((sum, s) => sum + s.count, 0);
  if (opponentGroundForceCount < 2) {
    return { ok: false, error: "Greyfire Mutagen Ω: the opponent needs at least 2 ground forces participating." };
  }
  const opponentInfantry = opponentStacks.find((s) => s.unitType === "infantry" && s.count > 0);
  if (!opponentInfantry) return { ok: false, error: "Greyfire Mutagen Ω: the opponent has no infantry to replace." };

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "infantry", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const updatedOpponentStacks = opponentStacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const ownStacks = (planet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  const existingOwn = ownStacks.find((s) => s.unitType === "infantry" && !s.upgradeId);
  if (existingOwn) existingOwn.count += 1;
  else ownStacks.push({ unitType: "infantry", count: 1, damagedCount: 0 });

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [opponentId]: updatedOpponentStacks, [action.playerId]: ownStacks } };
  const updatedPlayer: Player = { ...state.players[action.playerId], promissoryNotesInHand: state.players[action.playerId].promissoryNotesInHand.filter((id) => id !== ("yin_promissory_omega" as never)) };
  return {
    ok: true,
    state: {
      ...state,
      systems: { ...state.systems, [pending.systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === pending.currentInvasionPlanetId ? updatedPlanet : p)) } },
      players: { ...state.players, [action.playerId]: updatedPlayer },
    },
    events: [],
  };
}

/**
 * Yin Brotherhood "Brother Milor" (agent): resolving one queued offer —
 * see GameState.ts's own pendingBrotherMilorOffers doc comment and
 * phases/spaceCombat.ts's own assignHits for where offers get queued.
 * Confirmed (yjmrobert.com/tirules/factions/f_yin): "capacity is not
 * checked during combat... after combat ends, that player must remove
 * fighters/ground forces to meet their capacity limit" — this project's
 * own existing post-combat capacity-overflow machinery already handles
 * that generically, so newly placed fighters aren't validated against
 * capacity here at all.
 */
/**
 * Yin Brotherhood "Brother Milor" (agent): resolving one queued offer —
 * see GameState.ts's own pendingBrotherMilorOffers doc comment and
 * phases/spaceCombat.ts's own assignHits / phases/invasion.ts's own
 * assignGroundCombatHits for where offers get queued. Confirmed
 * (yjmrobert.com/tirules/factions/f_yin): "capacity is not checked
 * during combat... after combat ends, that player must remove
 * fighters/ground forces to meet their capacity limit" — this project's
 * own existing post-combat capacity-overflow machinery already handles
 * that generically, so newly placed units aren't validated against
 * capacity here at all.
 *
 * CORRECTED: the base version only ever places FIGHTERS in the
 * offer's own SPACE system (`offer.planetId` is never set there); the
 * Ω version (codex) also accepts INFANTRY, placed on `offer.planetId`
 * when the offer came from a ground combat, or (per the confirmed FAQ
 * note 8) even during a space-combat offer if the caller specifically
 * chooses infantry there — "any newly placed infantry cannot
 * participate" in that same space combat, which is naturally true here
 * since nothing re-adds it to this round's own combat entries.
 */
export function useBrotherMilor(
  state: GameState,
  action: { type: "USE_BROTHER_MILOR"; playerId: PlayerId; unitType: "fighter" | "infantry"; count: 1 | 2 },
  rules: RuleData,
): ActionResult {
  const yinPlayer = state.players[action.playerId];
  if (!yinPlayer || yinPlayer.factionId !== ("yin" as never)) return { ok: false, error: "Only the Yin player has Brother Milor." };
  const agentEntry = yinPlayer.leaders.find((l) => l.leaderId === ("yin_agent" as never));
  if (!agentEntry || agentEntry.locked || agentEntry.exhausted) return { ok: false, error: "Brother Milor isn't available." };
  const pending = state.pendingTacticalAction;
  const offer = pending?.pendingBrotherMilorOffers?.[0];
  if (!offer) return { ok: false, error: "No pending Brother Milor offer right now." };
  if (action.unitType === "infantry" && !hasCodex(state.mode)) {
    return { ok: false, error: "Brother Milor (base version) can only place fighters — infantry requires the Ω (codex) version." };
  }

  const reinforcementsCheck = checkReinforcementsAvailable(state, offer.targetPlayerId, [{ unitType: action.unitType, count: action.count }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const system = state.systems[offer.systemId];
  let nextState = state;
  if (action.unitType === "infantry" && offer.planetId) {
    const planet = system.planets.find((p) => p.planetId === offer.planetId)!;
    const stacks = (planet.unitsByPlayer[offer.targetPlayerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === "infantry" && !s.upgradeId);
    if (existing) existing.count += action.count;
    else stacks.push({ unitType: "infantry", count: action.count, damagedCount: 0 });
    const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [offer.targetPlayerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [offer.systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === offer.planetId ? updatedPlanet : p)) } } };
  } else {
    const stacks = (system.spaceUnitsByPlayer[offer.targetPlayerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === action.unitType && !s.upgradeId);
    if (existing) existing.count += action.count;
    else stacks.push({ unitType: action.unitType, count: action.count, damagedCount: 0 });
    const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [offer.targetPlayerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [offer.systemId]: updatedSystem } };
  }

  const updatedYin: Player = { ...nextState.players[action.playerId], leaders: nextState.players[action.playerId].leaders.map((l) => (l.leaderId === ("yin_agent" as never) ? { ...l, exhausted: true } : l)) };
  const remainingOffers = (pending!.pendingBrotherMilorOffers ?? []).slice(1);
  nextState = {
    ...nextState,
    players: { ...nextState.players, [action.playerId]: updatedYin },
    pendingTacticalAction: { ...nextState.pendingTacticalAction!, pendingBrotherMilorOffers: remainingOffers.length > 0 ? remainingOffers : undefined },
  };
  const events: import("../types/Actions").GameEvent[] = [
    { type: "UNITS_PRODUCED", playerId: offer.targetPlayerId, systemId: offer.systemId, planetId: action.unitType === "infantry" ? offer.planetId : undefined, unitType: action.unitType, count: action.count, totalCost: 0 },
  ];

  // CORRECTED: this used to just clear the offer and return, without
  // re-checking whether Brother Milor was the LAST thing blocking the
  // combat's own wrap-up — same "the resolving function itself re-checks
  // and re-triggers wrap-up" pattern phases/spaceCombat.ts's own
  // useDuraniumArmor/skipDuraniumArmor already use; without this, a
  // combat where Milor was the only pending item would never actually
  // conclude.
  const finalPending = nextState.pendingTacticalAction!;
  const nothingElsePending = (finalPending.pendingBrotherMilorOffers ?? []).length === 0 && (finalPending.crownOfThalnosPendingPlayers ?? []).length === 0;
  if (finalPending.step === "spaceCombat" && Object.keys(finalPending.pendingHits ?? {}).length === 0 && (finalPending.duraniumArmorPendingPlayers ?? []).length === 0 && nothingElsePending) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }
  if (finalPending.step === "invasion" && Object.keys(finalPending.pendingHits ?? {}).length === 0 && nothingElsePending) {
    const wrap = wrapUpGroundCombat(nextState, rules);
    return { ok: true, state: wrap.state, events: [...events, ...wrap.events] };
  }
  return { ok: true, state: nextState, events };
}

/** Yin Brotherhood "Brother Milor" (agent): declining the current offer — see useBrotherMilor's own doc comment. CORRECTED: same re-check-and-re-trigger-wrap-up fix as useBrotherMilor's own doc comment covers — skipping used to leave the combat stuck if Milor was the last pending item. */
export function skipBrotherMilor(state: GameState, action: { type: "SKIP_BROTHER_MILOR"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending?.pendingBrotherMilorOffers?.length) return { ok: false, error: "No pending Brother Milor offer right now." };
  const remainingOffers = pending.pendingBrotherMilorOffers.slice(1);
  const nextState: GameState = { ...state, pendingTacticalAction: { ...pending, pendingBrotherMilorOffers: remainingOffers.length > 0 ? remainingOffers : undefined } };

  const finalPending = nextState.pendingTacticalAction!;
  const nothingElsePending = (finalPending.pendingBrotherMilorOffers ?? []).length === 0 && (finalPending.crownOfThalnosPendingPlayers ?? []).length === 0;
  if (finalPending.step === "spaceCombat" && Object.keys(finalPending.pendingHits ?? {}).length === 0 && (finalPending.duraniumArmorPendingPlayers ?? []).length === 0 && nothingElsePending) {
    const wrap = wrapUpCombatRound(nextState, rules);
    return { ok: true, state: wrap.state, events: wrap.events };
  }
  if (finalPending.step === "invasion" && Object.keys(finalPending.pendingHits ?? {}).length === 0 && nothingElsePending) {
    const wrap = wrapUpGroundCombat(nextState, rules);
    return { ok: true, state: wrap.state, events: wrap.events };
  }
  return { ok: true, state: nextState, events: [] };
}

/**
 * Yin Brotherhood "Daneel of the Tenth — Spinner Overdrive" (hero):
 * "ACTION: For each planet that contains any number of your infantry,
 * either ready that planet or place an equal number of infantry from
 * your reinforcements on that planet. Then, purge this card." NOT
 * specifically handled: the confirmed FAQ note that a planet with ZERO
 * Yin infantry can still be readied this way — this implementation
 * requires each chosen planet to actually have 1+ Yin infantry present,
 * matching the card's own printed condition literally; flagged as a
 * narrower simplification rather than silently assumed correct.
 */
/**
 * Yin Brotherhood "Daneel of the Tenth — Spinner Overdrive" (hero):
 * "ACTION: For each planet that contains any number of your infantry,
 * either ready that planet or place an equal number of infantry from
 * your reinforcements on that planet. Then, purge this card." CORRECTED
 * (yjmrobert.com/tirules/factions/f_yin): "The Yin player may ready a
 * planet they control containing ZERO infantry" — an earlier version of
 * this function required 1+ infantry present for BOTH choices, which
 * was too strict for "ready" specifically (doubling zero infantry would
 * do nothing either way, so that requirement is correctly kept for the
 * "double" choice only).
 */
export function useDaneelOfTheTenth(
  state: GameState,
  action: { type: "USE_DANEEL_OF_THE_TENTH"; playerId: PlayerId; choices: { planetId: PlanetId; choice: "ready" | "double" }[] },
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player?.leaders.find((l) => l.leaderId === ("yin_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Daneel of the Tenth." };

  let nextState = state;
  for (const { planetId, choice } of action.choices) {
    let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      const planet = system.planets.find((p) => p.planetId === planetId);
      if (planet) {
        found = { systemId: systemId as SystemId, system, planet };
        break;
      }
    }
    if (!found || found.planet.controllerId !== action.playerId) {
      return { ok: false, error: `This player doesn't control ${planetId}.` };
    }

    if (choice === "ready") {
      const updatedPlanet: PlanetState = { ...found.planet, exhausted: false };
      nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
    } else {
      const infantryStack = (found.planet.unitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "infantry" && s.count > 0);
      if (!infantryStack) return { ok: false, error: `This player has no infantry on ${planetId} to double.` };
      const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.playerId, [{ unitType: "infantry", count: infantryStack.count }]);
      if (!reinforcementsCheck.ok) return reinforcementsCheck;
      const updatedStacks = (found.planet.unitsByPlayer[action.playerId] ?? []).map((s) => (s === infantryStack ? { ...s, count: s.count * 2 } : s));
      const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: updatedStacks } };
      nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
    }
  }

  const updatedPlayer: Player = { ...nextState.players[action.playerId], leaders: nextState.players[action.playerId].leaders.filter((l) => l.leaderId !== ("yin_hero" as never)) };
  return { ok: true, state: { ...nextState, players: { ...nextState.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * Yin Brotherhood "Dannel of the Tenth Ω — Quantum Dissemination Ω"
 * (hero, codex version — replaces the base "Spinner Overdrive" entirely
 * once hasCodex(state.mode) is true, same shared leader slot, same
 * one-shot purge-after-use shape). Confirmed
 * (yjmrobert.com/tirules/factions/f_yin):
 *  - "A total of 3 infantry may be placed. All on 1 planet, 1 each on 3
 *    planets, or split 2/1 between 2 planets."
 *  - "Only Commit Ground Forces, Ground Combat and Establish Control are
 *    resolved" — no system activation, no Bombardment, no Space Cannon
 *    Defense.
 *  - "The Yin player commits all infantry before resolving any combats."
 *  - Indoctrination and the mech's own Deploy remain usable throughout.
 *
 * ARCHITECTURAL LIMITATION, flagged rather than silently assumed
 * correct: this project's own pendingTacticalAction only ever tracks
 * ONE systemId at a time (matching how a REAL invasion always targets
 * multiple planets within a single ACTIVATED system) — but Quantum
 * Dissemination Ω can commit to planets across ENTIRELY DIFFERENT
 * systems in the same use, with no activation at all. Any destination
 * planet with NO opposing ground forces present is resolved completely
 * here (control established immediately, matching an uncontested
 * invasion's own outcome). For a CONTESTED destination (opposing ground
 * forces present, genuinely needing the normal multi-round interactive
 * combat flow — RESOLVE_COMBAT_ROUND / ASSIGN_HITS, which can't resolve
 * synchronously inside this one function call), only the FIRST such
 * planet gets a real pendingTacticalAction set up (reusing the exact
 * same "invasion" step machinery a normal tactical action already has,
 * so combat itself isn't duplicated logic). If MORE than one contested
 * destination was chosen, the remaining ones are NOT separately queued
 * here — a genuine, narrower gap given how deep an undertaking properly
 * chaining several cross-system combats back-to-back would be.
 */
export function useDaneelOfTheTenthOmega(
  state: GameState,
  action: { type: "USE_DANEEL_OF_THE_TENTH_OMEGA"; playerId: PlayerId; destinations: { planetId: PlanetId; count: number }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player?.leaders.find((l) => l.leaderId === ("yin_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Dannel of the Tenth." };
  if (!hasCodex(state.mode)) return { ok: false, error: "Quantum Dissemination Ω requires Codex — the base game version is Spinner Overdrive instead." };
  if (state.pendingTacticalAction) return { ok: false, error: "Quantum Dissemination Ω: no other tactical action can be in progress." };
  if (action.destinations.length < 1 || action.destinations.length > 3) {
    return { ok: false, error: "Quantum Dissemination Ω: choose 1 to 3 planets." };
  }
  const totalCount = action.destinations.reduce((sum, d) => sum + d.count, 0);
  if (totalCount !== 3 || action.destinations.some((d) => d.count < 1 || d.count > 3)) {
    return { ok: false, error: "Quantum Dissemination Ω: exactly 3 infantry total, distributed as 3/0/0, 2/1/0, or 1/1/1 across the chosen planets." };
  }
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "infantry", count: 3 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  let nextState = state;
  const foundByPlanet = new Map<PlanetId, { systemId: SystemId; system: SystemState; planet: PlanetState }>();
  for (const { planetId } of action.destinations) {
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      const planet = system.planets.find((p) => p.planetId === planetId);
      if (planet) {
        foundByPlanet.set(planetId, { systemId: systemId as SystemId, system, planet });
        break;
      }
    }
    if (!foundByPlanet.has(planetId)) return { ok: false, error: `Unknown planet ${planetId}.` };
  }

  // Commit Ground Forces (place infantry from reinforcements).
  for (const { planetId, count } of action.destinations) {
    const found = foundByPlanet.get(planetId)!;
    const currentPlanet = nextState.systems[found.systemId].planets.find((p) => p.planetId === planetId)!;
    const stacks = (currentPlanet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === "infantry" && !s.upgradeId);
    if (existing) existing.count += count;
    else stacks.push({ unitType: "infantry", count, damagedCount: 0 });
    const updatedPlanet: PlanetState = { ...currentPlanet, unitsByPlayer: { ...currentPlanet.unitsByPlayer, [action.playerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...nextState.systems[found.systemId], planets: nextState.systems[found.systemId].planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
  }

  // Establish Control immediately for any uncontested destination; queue the FIRST contested one for real combat.
  let firstContested: { systemId: SystemId; planetId: PlanetId } | null = null;
  for (const { planetId } of action.destinations) {
    const found = foundByPlanet.get(planetId)!;
    const currentPlanet = nextState.systems[found.systemId].planets.find((p) => p.planetId === planetId)!;
    const hasOpposingGroundForces = Object.entries(currentPlanet.unitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => GROUND_FORCE_TYPES.includes(s.unitType) && s.count > 0));
    if (!hasOpposingGroundForces) {
      const controlResult = setPlanetController(nextState, found.systemId, planetId, action.playerId, rules);
      nextState = controlResult.state;
    } else if (!firstContested) {
      firstContested = { systemId: found.systemId, planetId };
    }
  }

  const updatedPlayer: Player = { ...nextState.players[action.playerId], leaders: nextState.players[action.playerId].leaders.filter((l) => l.leaderId !== ("yin_hero" as never)) };
  nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: updatedPlayer } };

  if (firstContested) {
    nextState = {
      ...nextState,
      pendingTacticalAction: {
        playerId: action.playerId,
        systemId: firstContested.systemId,
        step: "invasion",
        invasionCommitsFinished: true,
        currentInvasionPlanetId: firstContested.planetId,
        remainingInvasionPlanetIds: [],
      },
    };
  }

  return { ok: true, state: nextState, events: [] };
}

/**
 * Yin Brotherhood "Yin Ascendant" (Breakthrough ability): "When you gain
 * this card or score a public objective, gain the alliance ability of a
 * random, unused faction." Confirmed
 * (yjmrobert.com/tirules/factions/f_yin): "the Yin player may use the
 * alliance ability as though that faction's commander were unlocked."
 *
 * IMPLEMENTATION NOTE: every commander-check this project has written so
 * far (Naalu's M'aban, Winnu's Rickar Rickani, Brother Omar just above,
 * etc.) checks the ACTING player's own `leaders` array for a specific
 * `{faction}_commander` id — never "is this player literally that
 * faction". That means simply adding a matching leader entry to the
 * YIN player's own `leaders` array (unlocked, unexhausted) makes every
 * one of those already-written checks correctly recognize Yin as having
 * that ability, with no separate retrofitting needed anywhere else in
 * the codebase. This is why `randomFactionId` is trusted directly from
 * the caller (the same "trusted RNG" convention as every dice roll
 * elsewhere in this project — this engine has no random-selection
 * primitive of its own) rather than this function picking one itself.
 *
 * NOT specifically handled: if the granted faction's own commander
 * doesn't actually have any wired engine mechanic yet (true for most
 * PoK/Thunder's Edge factions today), this grant is a harmless no-op
 * for that specific pick — a pre-existing gap in THAT faction's own
 * implementation, not something this function can fix.
 */
export function grantYinAscendant(state: GameState, playerId: PlayerId, rules: RuleData, randomFactionId?: string): GameState {
  const player = state.players[playerId];
  if (!player || player.factionId !== ("yin" as never) || !player.hasBreakthrough) return state;
  if (!randomFactionId || randomFactionId === "yin") return state;
  const commanderId = rules.factionLeaders[randomFactionId as never]?.commander?.id;
  if (!commanderId) return state;
  if (player.leaders.some((l) => l.leaderId === (commanderId as never))) return state; // already granted this same one
  const updatedPlayer: Player = { ...player, leaders: [...player.leaders, { leaderId: commanderId as never, locked: false, exhausted: false }] };
  return { ...state, players: { ...state.players, [playerId]: updatedPlayer } };
}
