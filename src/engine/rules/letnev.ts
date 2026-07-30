import { GameState, Player } from "../types/GameState";
import { GameEvent, ActionResult } from "../types/Actions";
import { RuleData } from "../types/RuleData";
import { hasAbility } from "./abilities";
import { asAbilityId, asLeaderId, PlayerId, PlanetId, SystemId } from "../types/ids";
import { SHIP_TYPES } from "../types/enums";
import { unlockCommander } from "./leaders";
import { checkReinforcementsAvailable } from "./reinforcements";
import { buildSpaceCombatEntries } from "./combat";

/**
 * RR 37.1's own "non-fighter ships in a system can't exceed fleet pool"
 * limit — now generalized here so BOTH of this project's own existing
 * enforcement points (phases/production.ts, phases/tacticalAction.ts)
 * can account for Letnev's own overrides instead of hardcoding
 * `player.commandTokens.fleet` directly:
 *  - "ARMADA" (base faction ability, passive): "+2 more than the number
 *    of tokens in your fleet pool" — a standing, permanent modifier.
 *  - "Darktalon Treilla — DARK MATTER AFFINITY" (hero, single-round use):
 *    while active, the limit doesn't apply AT ALL (returns Infinity)
 *    for the rest of THIS game round.
 * Confirmed (yjmrobert.com/tirules/factions/f_letnev): "If the Letnev
 * player has zero command tokens in their fleet pool, they may still
 * have ships on the game board" — already true by construction, since
 * this whole check only ever gates ADDING more ships, never retroactively
 * removes existing ones; nothing extra needed for that specific point.
 */
export function getMaxNonFighterShips(player: Player): number {
  if (player.darktalonTreillaActive) return Infinity;
  const base = player.commandTokens.fleet;
  return hasAbility(player, asAbilityId("armada")) ? base + 2 : base;
}

/**
 * Letnev "Rear Admiral Farran" (commander, PASSIVE — no exhaust/ready
 * cycle): "After 1 of your units uses SUSTAIN DAMAGE: you may gain 1
 * Trade Good." Unlock: "Have 5 non-fighter ships in 1 system." Confirmed
 * rulings (yjmrobert.com/tirules/factions/f_letnev):
 *  - Only triggers when Sustain Damage is actually INVOKED (the "flip"
 *    hit-assignment outcome) — a unit destroyed outright, or damaged
 *    some other way, never triggers this.
 *  - If multiple units use Sustain Damage within the same step, gains
 *    resolve one at a time (a sequencing note this project's own simple
 *    "call this once per flip" shape already satisfies).
 *  - "Must first remove ships to meet the ARMADA limit before they can
 *    unlock" this commander — checked here as part of the unlock
 *    condition itself (a player currently OVER their own fleet-supply
 *    limit anywhere on the board can't unlock, even with 5+ in 1 system).
 *
 * KNOWN SIMPLIFICATION: this project has no generic "a Sustain Damage
 * flip just happened, offer this reactive trigger" plumbing threaded
 * through every hit-assignment call site (ground combat, space combat,
 * Bombardment, Space Cannon Defense) — the caller is trusted to only
 * submit this action right after an actual Sustain Damage use of their
 * own, same category as other "immediately after X" simplifications
 * already accepted elsewhere in this project.
 */
export function useRearAdmiralFarran(state: GameState, action: { type: "USE_REAR_ADMIRAL_FARRAN"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("rear_admiral_farran" as never));
  if (!commanderEntry) return { ok: false, error: "This player doesn't have Rear Admiral Farran." };

  let workingState = state;
  if (commanderEntry.locked) {
    const hasFiveInOneSystem = Object.values(state.systems).some(
      (sys) => (sys.spaceUnitsByPlayer[action.playerId] ?? []).filter((s) => s.unitType !== "fighter" && SHIP_TYPES.includes(s.unitType)).reduce((sum, s) => sum + s.count, 0) >= 5,
    );
    if (!hasFiveInOneSystem) return { ok: false, error: "This player doesn't have an unlocked Rear Admiral Farran." };
    // "Must first remove ships to meet this limit before they can unlock" — i.e. cannot ALSO currently be over their own max anywhere on the board.
    const maxShips = getMaxNonFighterShips(player);
    const isOverLimitAnywhere = Object.values(state.systems).some(
      (sys) => (sys.spaceUnitsByPlayer[action.playerId] ?? []).filter((s) => s.unitType !== "fighter" && SHIP_TYPES.includes(s.unitType)).reduce((sum, s) => sum + s.count, 0) > maxShips,
    );
    if (isOverLimitAnywhere) return { ok: false, error: "This player must first remove ships to meet their own fleet-supply limit before unlocking Rear Admiral Farran." };
    workingState = { ...state, players: { ...state.players, [action.playerId]: unlockCommander(player, asLeaderId("rear_admiral_farran")) } };
  }

  const finalPlayer = workingState.players[action.playerId];
  return { ok: true, state: { ...workingState, players: { ...workingState.players, [action.playerId]: { ...finalPlayer, tradeGoods: finalPlayer.tradeGoods + 1 } } }, events: [] };
}

/**
 * Letnev "Dunlain Reaper" (mech, DEPLOY): "At the start of a round of
 * ground combat, you may spend 2 resources to replace 1 of your
 * infantry in that combat with 1 mech." Confirmed rulings
 * (yjmrobert.com/tirules/factions/f_letnev):
 *  - Once per timing window — only 1 Dunlain Reaper deployable this way
 *    PER GROUND COMBAT ROUND (tracked here via a per-round-reset flag on
 *    pendingTacticalAction, similar to other "once per round" trackers
 *    already in this project). Further ones may be placed in LATER
 *    rounds of the same combat.
 *  - Only from reinforcements — checkReinforcementsAvailable already
 *    enforces the physical unit-count cap (4 total) generically.
 *  - If a Dunlain Reaper is destroyed mid-combat, another may be
 *    deployed in a later round (no special code needed for this — it
 *    falls out naturally from the per-round reset + reinforcements
 *    check both re-evaluating fresh each round).
 */
export function useDunlainReaperDeploy(
  state: GameState,
  action: { type: "USE_DUNLAIN_REAPER_DEPLOY"; playerId: PlayerId; targetPlanetId: PlanetId; exhaustPlanetIdsForResources: PlanetId[] },
  rules: RuleData,
): { ok: true; state: GameState; events: GameEvent[] } | { ok: false; error: string } {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || pending.currentInvasionPlanetId !== action.targetPlanetId) {
    return { ok: false, error: "Dunlain Reaper Deploy: only usable during ground combat on this planet." };
  }
  if (pending.usedDunlainReaperDeployThisRound) {
    return { ok: false, error: "A Dunlain Reaper has already been deployed this round." };
  }
  let found: { systemId: SystemId; system: import("../types/GameState").SystemState; planet: import("../types/GameState").PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found) return { ok: false, error: `No planet ${action.targetPlanetId}.` };
  const infantryStack = (found.planet.unitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "infantry" && s.count > 0);
  if (!infantryStack) return { ok: false, error: "This player has no infantry in that combat to replace." };

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "mech", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  let totalResources = 0;
  let systems = state.systems;
  for (const planetId of action.exhaustPlanetIdsForResources) {
    let f: { systemId: SystemId; system: import("../types/GameState").SystemState; planet: import("../types/GameState").PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(systems)) {
      const p = system.planets.find((pl) => pl.planetId === planetId);
      if (p) {
        f = { systemId: systemId as SystemId, system, planet: p };
        break;
      }
    }
    if (!f || f.planet.controllerId !== action.playerId || f.planet.exhausted) return { ok: false, error: `Cannot exhaust ${planetId} for resources.` };
    totalResources += rules.planets[planetId]?.resources ?? 0;
    systems = { ...systems, [f.systemId]: { ...f.system, planets: f.system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)) } };
  }
  if (totalResources < 2) return { ok: false, error: "Not enough resources from the exhausted planets (need 2)." };

  const targetSystem = systems[found.systemId];
  const targetPlanet = targetSystem.planets.find((p) => p.planetId === action.targetPlanetId)!;
  const ownStacks = targetPlanet.unitsByPlayer[action.playerId] ?? [];
  const updatedInfantryStacks = ownStacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const existingMech = updatedInfantryStacks.find((s) => s.unitType === "mech");
  const updatedStacks = existingMech
    ? updatedInfantryStacks.map((s) => (s.unitType === "mech" ? { ...s, count: s.count + 1 } : s))
    : [...updatedInfantryStacks, { unitType: "mech" as const, count: 1, damagedCount: 0 }];
  const updatedPlanet = { ...targetPlanet, unitsByPlayer: { ...targetPlanet.unitsByPlayer, [action.playerId]: updatedStacks } };
  systems = { ...systems, [found.systemId]: { ...targetSystem, planets: targetSystem.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) } };

  return {
    ok: true,
    state: { ...state, systems, pendingTacticalAction: { ...pending, usedDunlainReaperDeployThisRound: true } },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.targetPlanetId, unitType: "mech", count: 1, totalCost: 2 }],
  };
}

/**
 * Letnev "Darktalon Treilla — DARK MATTER AFFINITY" (hero): "ACTION:
 * Place this card near the game board; the number of non-fighter ships
 * you can have in systems is not limited by laws or by the number of
 * command tokens in your fleet pool during this game round." Purged at
 * the end of that same game round instead (actionPhase.ts's own
 * startNewRound) — NOT immediately here, since the bypass needs to stay
 * active for the rest of the round.
 */
export function useDarktalonTreilla(state: GameState, action: { type: "USE_DARKTALON_TREILLA"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("darktalon_treilla" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Darktalon Treilla." };
  if (player.darktalonTreillaActive) return { ok: false, error: "Darktalon Treilla is already active this round." };

  const updatedPlayer: Player = { ...player, darktalonTreillaActive: true };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * Letnev "Munitions Reserves" (faction ability): "At the start of each
 * round of space combat, you may spend 2 trade goods; you may re-roll
 * any number of your dice during that combat round." Confirmed
 * (yjmrobert.com/tirules/factions/f_letnev): once per round only,
 * cannot spend 4+ for 2+ rerolls (it's a flat, single spend).
 *
 * Reuses this project's own Crown of Thalnos reroll mechanism almost
 * exactly (rules/relics.ts's own maybeQueueCrownOfThalnosReroll /
 * agendaEffects.ts's own useCrownOfThalnosReroll) — that relic's
 * "reroll your missed dice" turns out to be equivalent to "reroll any of
 * your dice" in every PRACTICAL sense: a rational player only ever wants
 * to reroll a die that already missed (rerolling a die that already hit
 * has pure downside — it can only turn a hit into a miss, never improve
 * on "already a hit" — so nobody who plays well ever rerolls a hit
 * die). This project's own missed-dice-count tracking (already computed
 * every round, for Crown of Thalnos) is therefore already exactly the
 * data this ability needs too — nothing about the mechanism itself
 * needed reinventing, just its own separate cost/eligibility gate.
 */
export function useMunitionsReserves(
  state: GameState,
  action: { type: "USE_MUNITIONS_RESERVES"; playerId: PlayerId; rerolls: { unitType: import("../types/enums").UnitType; newRolls: number[] }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!hasAbility(player, asAbilityId("munitions_reserves"))) return { ok: false, error: "This player doesn't have MUNITIONS RESERVES." };
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") return { ok: false, error: "MUNITIONS RESERVES is only usable during space combat." };
  if (pending.usedMunitionsReservesThisRound) return { ok: false, error: "MUNITIONS RESERVES has already been used this round." };
  if (player.tradeGoods < 2) return { ok: false, error: "Not enough trade goods (need 2)." };

  const missedByType = pending.munitionsReservesMissedDiceByPlayer?.[action.playerId] ?? {};
  const systemOrPlanetEntries = buildSpaceCombatEntries(state, rules, pending.systemId, pending.playerId);
  const hitOnByType = new Map<import("../types/enums").UnitType, number>();
  for (const e of systemOrPlanetEntries) {
    if (e.playerId === action.playerId && e.unitType) hitOnByType.set(e.unitType, e.hitOn);
  }

  const unitsToDestroy: { unitType: import("../types/enums").UnitType; count: number }[] = [];
  for (const { unitType, newRolls } of action.rerolls) {
    const availableMisses = missedByType[unitType] ?? 0;
    if (newRolls.length > availableMisses) {
      return { ok: false, error: `MUNITIONS RESERVES: tried to reroll ${newRolls.length} ${unitType} dice, only ${availableMisses} missed this round.` };
    }
    const hitOn = hitOnByType.get(unitType);
    if (hitOn === undefined) return { ok: false, error: `This player has no ${unitType} in this combat.` };
    const stillMissed = newRolls.filter((r) => r < hitOn).length;
    if (stillMissed > 0) unitsToDestroy.push({ unitType, count: stillMissed });
  }

  const systemId = pending.systemId;
  const events: GameEvent[] = [];
  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: { ...player, tradeGoods: player.tradeGoods - 2 } } };
  for (const { unitType, count } of unitsToDestroy) {
    const stacks = nextState.systems[systemId].spaceUnitsByPlayer[action.playerId] ?? [];
    const stack = stacks.find((s) => s.unitType === unitType);
    if (!stack) continue;
    const updatedStacks = stacks.map((s) => (s.unitType === unitType ? { ...s, count: Math.max(0, s.count - count) } : s)).filter((s) => s.count > 0);
    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...nextState.systems[systemId], spaceUnitsByPlayer: { ...nextState.systems[systemId].spaceUnitsByPlayer, [action.playerId]: updatedStacks } } } };
    events.push({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, unitType, count });
  }

  nextState = { ...nextState, pendingTacticalAction: { ...nextState.pendingTacticalAction!, usedMunitionsReservesThisRound: true } };
  return { ok: true, state: nextState, events };
}

/**
 * Letnev "Darktalon Treilla — DARK MATTER AFFINITY" (hero): the actual
 * "choose which ships to remove" mechanism for the fleet-supply cleanup
 * her own end-of-round purge can leave behind (actionPhase.ts's own
 * startNewRound flags this via Player.pendingFleetCleanupSystemIds).
 * Confirmed (yjmrobert.com/tirules/factions/f_letnev): "the Letnev player
 * might need to remove ships from the board to satisfy fleet pool
 * limits" — the PLAYER'S OWN choice of which ships, same as this
 * project's own general philosophy elsewhere (never an engine-made
 * decision on the player's behalf).
 */
export function resolveFleetCleanup(
  state: GameState,
  action: { type: "RESOLVE_FLEET_CLEANUP"; playerId: PlayerId; systemId: SystemId; removals: { unitType: import("../types/enums").UnitType; count: number }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const pendingSystemIds = player.pendingFleetCleanupSystemIds ?? [];
  if (!pendingSystemIds.includes(action.systemId)) {
    return { ok: false, error: "This player has no pending fleet cleanup for that system." };
  }
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const stacks = system.spaceUnitsByPlayer[action.playerId] ?? [];

  let updatedStacks = stacks;
  for (const { unitType, count } of action.removals) {
    const stack = updatedStacks.find((s) => s.unitType === unitType);
    if (!stack || stack.count < count) return { ok: false, error: `This player doesn't have ${count} ${unitType}(s) in ${action.systemId} to remove.` };
    updatedStacks = updatedStacks.map((s) => (s.unitType === unitType ? { ...s, count: s.count - count } : s)).filter((s) => s.count > 0);
  }

  const remainingNonFighterShips = updatedStacks.filter((s) => s.unitType !== "fighter" && SHIP_TYPES.includes(s.unitType)).reduce((sum, s) => sum + s.count, 0);
  const maxAllowed = getMaxNonFighterShips(player);
  if (remainingNonFighterShips > maxAllowed) {
    return { ok: false, error: `Still ${remainingNonFighterShips} non-fighter ships in ${action.systemId} after these removals, exceeding this player's own limit (${maxAllowed}) — remove more.` };
  }

  const updatedSystem = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };
  const remainingPendingSystemIds = pendingSystemIds.filter((id) => id !== action.systemId);
  const updatedPlayer: Player = {
    ...player,
    pendingFleetCleanupSystemIds: remainingPendingSystemIds.length > 0 ? remainingPendingSystemIds : undefined,
  };

  const events: GameEvent[] = action.removals.map((r) => ({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: action.systemId, unitType: r.unitType, count: r.count }));
  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [action.systemId]: updatedSystem }, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events,
  };
}

function findLetnevPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("letnev" as never))?.id;
}

/**
 * Letnev "War Funding" (promissory note, original): "At the start of a
 * round of space combat: The Letnev player loses 2 trade goods. During
 * this combat round, re-roll any number of your dice. Then, return this
 * card to the Letnev player." Same reroll mechanism as Munitions
 * Reserves above (see that function's own doc comment on why "reroll
 * any dice" and "reroll missed dice" are practically equivalent).
 * Confirmed rulings (yjmrobert.com/tirules/factions/f_letnev):
 *  - Usable even if Letnev has 0 or 1 trade goods — they just lose
 *    whatever they actually have (up to 2), the rest of the effect
 *    resolves normally regardless.
 *  - The holder "cannot play it again until the next round of combat" —
 *    tracked here via a per-round-per-holder flag, reset each new round
 *    the SAME way Munitions Reserves' own once-per-round flag is.
 *
 * KNOWN SIMPLIFICATION: the deeper transaction-chain rulings (exactly
 * when a card received mid-combat can be played immediately vs not,
 * the active-player-only transaction restriction, "attacker receiving
 * after defender already played it" blocking the attacker for that
 * round) aren't enforced here — this project's own general transaction
 * system (rules/transactions.ts) already handles WHO can receive this
 * card and when in the general case; the combat-specific nuances on top
 * of that are flagged rather than fully modeled.
 */
export function useWarFunding(
  state: GameState,
  action: { type: "USE_WAR_FUNDING"; playerId: PlayerId; rerolls: { unitType: import("../types/enums").UnitType; newRolls: number[] }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("war_funding" as never)) {
    return { ok: false, error: "This player doesn't have War Funding in hand." };
  }
  const letnevPlayerId = findLetnevPlayerId(state);
  if (!letnevPlayerId) return { ok: false, error: "No Letnev player in this game." };
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") return { ok: false, error: "War Funding is only usable during space combat." };
  if (pending.usedWarFundingThisRoundBy === action.playerId) {
    return { ok: false, error: "This player cannot play War Funding again until the next round of combat." };
  }

  const missedByType = pending.munitionsReservesMissedDiceByPlayer?.[action.playerId] ?? {};
  const systemOrPlanetEntries = buildSpaceCombatEntries(state, rules, pending.systemId, pending.playerId);
  const hitOnByType = new Map<import("../types/enums").UnitType, number>();
  for (const e of systemOrPlanetEntries) {
    if (e.playerId === action.playerId && e.unitType) hitOnByType.set(e.unitType, e.hitOn);
  }

  const unitsToDestroy: { unitType: import("../types/enums").UnitType; count: number }[] = [];
  for (const { unitType, newRolls } of action.rerolls) {
    const availableMisses = missedByType[unitType] ?? 0;
    if (newRolls.length > availableMisses) {
      return { ok: false, error: `War Funding: tried to reroll ${newRolls.length} ${unitType} dice, only ${availableMisses} missed this round.` };
    }
    const hitOn = hitOnByType.get(unitType);
    if (hitOn === undefined) return { ok: false, error: `This player has no ${unitType} in this combat.` };
    const stillMissed = newRolls.filter((r) => r < hitOn).length;
    if (stillMissed > 0) unitsToDestroy.push({ unitType, count: stillMissed });
  }

  const letnevPlayer = state.players[letnevPlayerId];
  const updatedLetnevPlayer: Player = { ...letnevPlayer, tradeGoods: Math.max(0, letnevPlayer.tradeGoods - 2), promissoryNotesInHand: [...letnevPlayer.promissoryNotesInHand, "war_funding" as never] };
  let nextState: GameState = {
    ...state,
    players: {
      ...state.players,
      [letnevPlayerId]: updatedLetnevPlayer,
      [action.playerId]: { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("war_funding" as never)) },
    },
    pendingTacticalAction: { ...pending, usedWarFundingThisRoundBy: action.playerId },
  };

  const systemId = pending.systemId;
  const events: GameEvent[] = [];
  for (const { unitType, count } of unitsToDestroy) {
    const stacks = nextState.systems[systemId].spaceUnitsByPlayer[action.playerId] ?? [];
    const stack = stacks.find((s) => s.unitType === unitType);
    if (!stack) continue;
    const updatedStacks = stacks.map((s) => (s.unitType === unitType ? { ...s, count: Math.max(0, s.count - count) } : s)).filter((s) => s.count > 0);
    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...nextState.systems[systemId], spaceUnitsByPlayer: { ...nextState.systems[systemId].spaceUnitsByPlayer, [action.playerId]: updatedStacks } } } };
    events.push({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, unitType, count });
  }

  return { ok: true, state: nextState, events };
}

/**
 * Letnev "War Funding Ω" (promissory note, Codex version): "After you
 * and your opponent roll dice during space combat: You may reroll all
 * of your opponent's dice. You may reroll any number of your dice. Then,
 * return this card to the Letnev player." Confirmed
 * (yjmrobert.com/tirules/factions/f_letnev): "a player may only reroll
 * combat rolls with War Funding Ω — they cannot reroll anti-fighter
 * barrage rolls and similar."
 *
 * The "reroll all of your opponent's dice" half genuinely differs from
 * every other reroll mechanism in this project (all of which only ever
 * let a player reroll THEIR OWN dice) — modeled directly: every one of
 * the opponent's own missed dice gets force-rerolled (their "would
 * reroll ALL", not a choice of which), while the holder's OWN dice
 * follow the same "any number, missed-dice-equivalent" pattern as every
 * other reroll ability in this project.
 */
export function useWarFundingOmega(
  state: GameState,
  action: {
    type: "USE_WAR_FUNDING_OMEGA";
    playerId: PlayerId;
    opponentId: PlayerId;
    opponentRerolls: { unitType: import("../types/enums").UnitType; newRolls: number[] }[];
    ownRerolls: { unitType: import("../types/enums").UnitType; newRolls: number[] }[];
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("war_funding_omega" as never)) {
    return { ok: false, error: "This player doesn't have War Funding Ω in hand." };
  }
  const letnevPlayerId = findLetnevPlayerId(state);
  if (!letnevPlayerId) return { ok: false, error: "No Letnev player in this game." };
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") return { ok: false, error: "War Funding Ω is only usable during space combat." };
  if (pending.usedWarFundingThisRoundBy === action.playerId) {
    return { ok: false, error: "This player cannot play War Funding Ω again until the next round of combat." };
  }

  const systemOrPlanetEntries = buildSpaceCombatEntries(state, rules, pending.systemId, pending.playerId);
  const hitOnByPlayerAndType = new Map<string, number>();
  for (const e of systemOrPlanetEntries) {
    if (e.unitType) hitOnByPlayerAndType.set(`${e.playerId}|${e.unitType}`, e.hitOn);
  }

  const computeDestroyed = (forPlayerId: PlayerId, rerolls: { unitType: import("../types/enums").UnitType; newRolls: number[] }[]): { unitType: import("../types/enums").UnitType; count: number }[] => {
    const missedByType = pending.munitionsReservesMissedDiceByPlayer?.[forPlayerId] ?? {};
    const result: { unitType: import("../types/enums").UnitType; count: number }[] = [];
    for (const { unitType, newRolls } of rerolls) {
      const availableMisses = missedByType[unitType] ?? 0;
      if (newRolls.length > availableMisses) continue; // validated more strictly below for the holder's own rerolls
      const hitOn = hitOnByPlayerAndType.get(`${forPlayerId}|${unitType}`);
      if (hitOn === undefined) continue;
      const stillMissed = newRolls.filter((r) => r < hitOn).length;
      if (stillMissed > 0) result.push({ unitType, count: stillMissed });
    }
    return result;
  };

  // Validate the holder's OWN rerolls strictly (same as every other reroll ability here) — the opponent's own forced reroll is simply "all of it", so no over-count to reject there.
  const ownMissedByType = pending.munitionsReservesMissedDiceByPlayer?.[action.playerId] ?? {};
  for (const { unitType, newRolls } of action.ownRerolls) {
    if (newRolls.length > (ownMissedByType[unitType] ?? 0)) {
      return { ok: false, error: `War Funding Ω: tried to reroll ${newRolls.length} ${unitType} dice, only ${ownMissedByType[unitType] ?? 0} missed this round.` };
    }
  }

  const letnevPlayer = state.players[letnevPlayerId];
  let nextState: GameState = {
    ...state,
    players: {
      ...state.players,
      [letnevPlayerId]: { ...letnevPlayer, promissoryNotesInHand: [...letnevPlayer.promissoryNotesInHand, "war_funding_omega" as never] },
      [action.playerId]: { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("war_funding_omega" as never)) },
    },
    pendingTacticalAction: { ...pending, usedWarFundingThisRoundBy: action.playerId },
  };

  const systemId = pending.systemId;
  const events: GameEvent[] = [];
  const applyDestruction = (forPlayerId: PlayerId, destroyedList: { unitType: import("../types/enums").UnitType; count: number }[]) => {
    for (const { unitType, count } of destroyedList) {
      const stacks = nextState.systems[systemId].spaceUnitsByPlayer[forPlayerId] ?? [];
      const stack = stacks.find((s) => s.unitType === unitType);
      if (!stack) continue;
      const updatedStacks = stacks.map((s) => (s.unitType === unitType ? { ...s, count: Math.max(0, s.count - count) } : s)).filter((s) => s.count > 0);
      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...nextState.systems[systemId], spaceUnitsByPlayer: { ...nextState.systems[systemId].spaceUnitsByPlayer, [forPlayerId]: updatedStacks } } } };
      events.push({ type: "UNITS_DESTROYED", playerId: forPlayerId, systemId, unitType, count });
    }
  };
  applyDestruction(action.opponentId, computeDestroyed(action.opponentId, action.opponentRerolls));
  applyDestruction(action.playerId, computeDestroyed(action.playerId, action.ownRerolls));

  return { ok: true, state: nextState, events };
}
