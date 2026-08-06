import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asAbilityId } from "../types/ids";
import { RuleData, getUnitStats } from "../types/RuleData";
import { GROUND_FORCE_TYPES } from "../types/enums";
import { hasAbility } from "./abilities";
import { arePlayersNeighbors } from "./adjacency";
import { checkReinforcementsAvailable } from "./reinforcements";
import { spendForCost } from "../phases/technology";
import { drawActionCard } from "../phases/actionCards";
import { drawActionCardsForPlayer } from "./yssaril";
import { getMaxNonFighterShips } from "./letnev";

function findMentakPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("mentak" as never))?.id;
}

/**
 * Mentak Coalition "Promise of Protection" (promissory note): "ACTION:
 * Place this card face-up in your play area. While this card is in your
 * play area, the Mentak player cannot use their PILLAGE faction ability
 * against you. If you activate a system that contains 1 or more of the
 * Mentak player's units, return this card to the Mentak player."
 * Confirmed (yjmrobert.com/tirules/factions/f_mentak):
 *  - Does NOT block Pillage against the holder if the HOLDER resolves a
 *    transaction with someone else — only blocks Pillage being used
 *    against the holder specifically, not the holder's own actions from
 *    triggering Pillage against a THIRD party.
 *  - No effect while in hand.
 *  - Returned on activation even with no hostile intent, and even for a
 *    structures-only system.
 *  - NOT returned by a non-tactical-action command placement (e.g.
 *    Diplomacy's own primary).
 */
export function usePromiseOfProtection(state: GameState, action: { type: "USE_PROMISE_OF_PROTECTION"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("mentak_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Promise of Protection in hand." };
  }
  const updatedPlayer: Player = {
    ...player,
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("mentak_promissory" as never)),
    promissoryNotesInPlayArea: [...player.promissoryNotesInPlayArea, "mentak_promissory" as never],
  };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * The return half of Promise of Protection — called from
 * phases/tacticalAction.ts's own activateSystem, same hook point as
 * Hacan's own maybeReturnTradeConvoys / Arborec's own maybeReturnStymie.
 */
export function maybeReturnPromiseOfProtection(state: GameState, activatingPlayerId: PlayerId, activatedSystemHasMentakUnits: boolean): GameState {
  if (!activatedSystemHasMentakUnits) return state;
  const mentakPlayerId = findMentakPlayerId(state);
  if (!mentakPlayerId || activatingPlayerId === mentakPlayerId) return state;

  let players = state.players;
  for (const [holderId, holder] of Object.entries(players)) {
    if (!holder.promissoryNotesInPlayArea.includes("mentak_promissory" as never)) continue;
    const mentakPlayer = players[mentakPlayerId];
    players = {
      ...players,
      [holderId]: { ...holder, promissoryNotesInPlayArea: holder.promissoryNotesInPlayArea.filter((id) => id !== ("mentak_promissory" as never)) },
      [mentakPlayerId]: { ...mentakPlayer, promissoryNotesInHand: [...mentakPlayer.promissoryNotesInHand, "mentak_promissory" as never] },
    };
  }
  return { ...state, players };
}

/**
 * Mentak Coalition "PILLAGE" (faction ability): "After 1 of your
 * neighbors gains trade goods or resolves a transaction, if they have 3
 * or more trade goods, you may take 1 of their trade goods or
 * commodities." Confirmed (yjmrobert.com/tirules/factions/f_mentak):
 *  - Does NOT make anyone a "neighbor" via other effects (e.g. the
 *    agenda phase, Hacan's own Trade Convoys) — only ACTUAL neighbor
 *    status (checked via arePlayersNeighbors) counts.
 *  - "Force to give" effects (e.g. S'ula Mentarion) are NOT
 *    transactions and don't trigger this.
 *  - If a player gains MULTIPLE trade goods one at a time, Mentak may
 *    use Pillage for EACH one — not modeled as a special multi-trigger
 *    here; the caller is trusted to invoke this once per qualifying
 *    gain (same "immediately after X" convention as elsewhere).
 *  - Converting commodities to trade goods (a "convert", not a "gain")
 *    does NOT trigger this.
 *  - Works even if the transaction didn't involve trade goods at all
 *    (as long as the TARGET currently has 3+ TG).
 *  - Can be used against BOTH players in a single transaction (2
 *    separate uses, once per target).
 *  - Decided AFTER the transaction/gain already resolved — any earlier
 *    "deal" not to use it is non-binding.
 */
export function usePillage(
  state: GameState,
  action: { type: "USE_PILLAGE"; playerId: PlayerId; targetPlayerId: PlayerId; take: "trade_good" | "commodity" },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!hasAbility(player, asAbilityId("pillage"))) return { ok: false, error: "This player doesn't have PILLAGE." };
  if (!arePlayersNeighbors(state, action.playerId, action.targetPlayerId, rules)) {
    return { ok: false, error: "PILLAGE can only be used against a neighbor." };
  }
  if ((state.players[action.targetPlayerId]?.promissoryNotesInPlayArea ?? []).includes("mentak_promissory" as never)) {
    return { ok: false, error: "That player has Promise of Protection in their play area." };
  }
  const target = state.players[action.targetPlayerId];
  if (target.tradeGoods < 3) return { ok: false, error: "PILLAGE: that player must have 3 or more trade goods." };

  let updatedTarget: Player;
  if (action.take === "trade_good") {
    updatedTarget = { ...target, tradeGoods: target.tradeGoods - 1 };
  } else {
    if (target.commodities <= 0) return { ok: false, error: "That player has no commodities to take." };
    updatedTarget = { ...target, commodities: target.commodities - 1 };
  }
  const updatedPlayer: Player = action.take === "trade_good" ? { ...player, tradeGoods: player.tradeGoods + 1 } : { ...player, commodities: player.commodities + 1 };

  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [action.targetPlayerId]: updatedTarget } },
    events: [{ type: "PILLAGE_USED", playerId: action.playerId, targetPlayerId: action.targetPlayerId, took: action.take }],
  };
}

/**
 * Mentak Coalition "Salvage Operations" (faction tech): "After you win
 * or lose a space combat, gain 1 trade good; if you won the combat, you
 * may also produce 1 ship in that system of any ship type that was
 * destroyed during the combat." Confirmed
 * (yjmrobert.com/tirules/factions/f_mentak):
 *  - The produced unit must be paid for.
 *  - If the combat ends in a draw, this has no effect at all (not even
 *    the trade good).
 *  - Steal-from-elsewhere fallback if reinforcements are empty (same
 *    pattern as Freelancers/ASSIMILATE/etc.).
 *  - If the OPPONENT's destroyed ship was faction-specific (including
 *    their flagship), Mentak may produce a GENERIC ship of that same
 *    TYPE, or their own Fourth Moon, as appropriate — the caller's own
 *    choice of unitType handles this naturally (no special-casing
 *    needed here beyond validating it against Mentak's OWN roster).
 *  - Cannot produce ground forces this way, even if the opponent's own
 *    ground force was being treated as a ship by some other effect.
 *  - Cannot produce a war sun without Mentak actually owning war sun
 *    technology.
 */
export function useSalvageOperations(
  state: GameState,
  action: { type: "USE_SALVAGE_OPERATIONS"; playerId: PlayerId; won: boolean; systemId: SystemId; unitType?: import("../types/enums").UnitType; exhaustPlanetIdsForResources?: PlanetId[]; substituteSourceSystemId?: SystemId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("salvage_operations" as never)) {
    return { ok: false, error: "This player doesn't have Salvage Operations." };
  }

  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: { ...player, tradeGoods: player.tradeGoods + 1 } } };
  const events: GameEvent[] = [];

  if (!action.won || !action.unitType) {
    return { ok: true, state: nextState, events };
  }
  if (GROUND_FORCE_TYPES.includes(action.unitType)) {
    return { ok: false, error: "Salvage Operations cannot produce ground forces." };
  }
  if (action.unitType === "war_sun" && !player.technologies.includes("war_sun" as never)) {
    return { ok: false, error: "This player doesn't have War Sun technology." };
  }
  const stats = getUnitStats(rules, player.factionId, action.unitType, player.unitUpgrades);
  if (!stats || stats.cost == null) return { ok: false, error: `No cost data for ${action.unitType}.` };

  const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.playerId, [{ unitType: action.unitType, count: 1 }]);
  let substituteRemoval: { systemId: SystemId; unitType: import("../types/enums").UnitType } | null = null;
  if (!reinforcementsCheck.ok) {
    if (!action.substituteSourceSystemId) return reinforcementsCheck;
    if (player.commandTokens.onBoard.includes(action.substituteSourceSystemId)) {
      return { ok: false, error: "Salvage Operations: the substitute system cannot contain this player's own command token." };
    }
    const substituteSystem = nextState.systems[action.substituteSourceSystemId];
    if (!substituteSystem || !(substituteSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === action.unitType && s.count > 0)) {
      return { ok: false, error: `No ${action.unitType} of this player's own in ${action.substituteSourceSystemId} to relocate.` };
    }
    substituteRemoval = { systemId: action.substituteSourceSystemId, unitType: action.unitType };
  }

  const spend = spendForCost(nextState, action.playerId, stats.cost, action.exhaustPlanetIdsForResources ?? [], rules);
  if (!spend.ok) return spend;
  nextState = spend.state;

  if (substituteRemoval) {
    const srcSystem = nextState.systems[substituteRemoval.systemId];
    const stacks = srcSystem.spaceUnitsByPlayer[action.playerId] ?? [];
    const stack = stacks.find((s) => s.unitType === substituteRemoval!.unitType)!;
    const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    nextState = { ...nextState, systems: { ...nextState.systems, [substituteRemoval.systemId]: { ...srcSystem, spaceUnitsByPlayer: { ...srcSystem.spaceUnitsByPlayer, [action.playerId]: updatedStacks } } } };
  }

  const destSystem = nextState.systems[action.systemId];
  const destStacks = destSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = destStacks.find((s) => s.unitType === action.unitType);
  const updatedDestStacks = existing ? destStacks.map((s) => (s.unitType === action.unitType ? { ...s, count: s.count + 1 } : s)) : [...destStacks, { unitType: action.unitType, count: 1, damagedCount: 0 }];
  nextState = { ...nextState, systems: { ...nextState.systems, [action.systemId]: { ...destSystem, spaceUnitsByPlayer: { ...destSystem.spaceUnitsByPlayer, [action.playerId]: updatedDestStacks } } } };
  events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, unitType: action.unitType, count: 1, totalCost: stats.cost });

  return { ok: true, state: nextState, events };
}

/**
 * Mentak Coalition "AMBUSH" (faction ability): "At the start of a space
 * combat, you may roll 1 die for each of up to 2 of your cruisers or
 * destroyers in the system. For each result equal to or greater than
 * that ship's combat value, produce 1 hit; your opponent must assign it
 * to 1 of their ships." Confirmed (yjmrobert.com/tirules/factions/f_mentak):
 *  - Rerolls/modifiers that affect NORMAL combat rolls do NOT apply to
 *    these rolls — modeled by never routing through buildSpaceCombatEntries
 *    at all; the caller submits the chosen ships' own raw combat values
 *    directly here instead.
 *  - A cruiser/destroyer destroyed BEFORE this resolves can't be used —
 *    checked against CURRENT board state, same as every other "must
 *    still be there" check in this project.
 *  - Shields Holding/Sustain Damage may cancel the resulting hit — not
 *    specially handled here; the hit is simply queued into the SAME
 *    pendingHits mechanism every other hit-producing ability uses, so
 *    the normal ASSIGN_HITS flow (including Sustain Damage) already
 *    applies to it without anything extra.
 */
export function useAmbush(
  state: GameState,
  action: { type: "USE_AMBUSH"; playerId: PlayerId; systemId: SystemId; ships: { unitType: "cruiser" | "destroyer"; diceRolls: number[] }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!hasAbility(player, asAbilityId("ambush"))) return { ok: false, error: "This player doesn't have AMBUSH." };
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat" || pending.combatRound !== 1) {
    return { ok: false, error: "AMBUSH is only usable at the start of the first round of space combat." };
  }
  const totalShipsUsed = action.ships.reduce((sum, s) => sum + s.diceRolls.length, 0);
  if (totalShipsUsed > 2) return { ok: false, error: "AMBUSH: at most 2 cruisers/destroyers total." };

  const system = state.systems[action.systemId];
  const stacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  let hits = 0;
  for (const { unitType, diceRolls } of action.ships) {
    const stack = stacks.find((s) => s.unitType === unitType && s.count > 0);
    if (!stack || diceRolls.length > stack.count) {
      return { ok: false, error: `Not enough ${unitType} in this system for AMBUSH.` };
    }
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats) return { ok: false, error: `No stats for ${unitType}.` };
    if (stats.combat == null) return { ok: false, error: `${unitType} has no combat value.` };
    hits += diceRolls.filter((r) => r >= stats.combat!).length;
  }
  if (hits <= 0) return { ok: true, state, events: [] };

  const opponentId = Object.keys(system.spaceUnitsByPlayer).find((id) => id !== action.playerId && (system.spaceUnitsByPlayer[id as PlayerId] ?? []).some((s) => s.count > 0)) as PlayerId | undefined;
  if (!opponentId) return { ok: false, error: "No opponent in this system." };

  const nextState: GameState = { ...state, pendingTacticalAction: { ...pending, pendingHits: { ...pending.pendingHits, [opponentId]: (pending.pendingHits?.[opponentId] ?? 0) + hits } } };
  return { ok: true, state: nextState, events: [{ type: "HARROW_HITS_SCORED", playerId: action.playerId, targetPlayerId: opponentId, hits }] };
}

/**
 * Mentak Coalition "Suffi An" (agent): "After the PILLAGE faction
 * ability is used against another player: You may exhaust this card;
 * if you do, you and that player each draw 1 action card." No
 * additional confirmed rulings beyond the printed text.
 */
export function useSuffiAn(
  state: GameState,
  action: { type: "USE_SUFFI_AN"; playerId: PlayerId; pillagedPlayerId: PlayerId },
): ActionResult {
  const player = state.players[action.playerId];
  const agentEntry = player.leaders.find((l) => l.leaderId === ("mentak_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have Suffi An." };
  if (agentEntry.exhausted) return { ok: false, error: "Suffi An is already exhausted." };

  // Yssaril Tribes "Ssruu" cross-faction note (tirules2.com/F_yssaril):
  // "If the Yssaril player duplicates the Mentak player's Suffi An
  // agent, then the Yssaril player and the player targeted by the
  // Mentak player's Pillage ability will draw action cards [triggering
  // SCHEMING for whichever of THOSE two is Yssaril]. The Mentak player
  // will not [own Scheming]." — using the shared drawActionCardsForPlayer
  // helper here (rather than a raw drawActionCard loop) means this is
  // already correctly handled for BOTH players, regardless of who's
  // actually holding Suffi An versus who's being pillaged.
  const draw1 = drawActionCardsForPlayer(state, action.playerId, 1);
  const draw2 = drawActionCardsForPlayer(draw1.state, action.pillagedPlayerId, 1);

  const updatedPlayer: Player = { ...draw2.state.players[action.playerId], leaders: draw2.state.players[action.playerId].leaders.map((l) => (l.leaderId === ("mentak_agent" as never) ? { ...l, exhausted: true } : l)) };

  return {
    ok: true,
    state: { ...draw2.state, players: { ...draw2.state.players, [action.playerId]: updatedPlayer } },
    events: [...draw1.events, ...draw2.events],
  };
}

/**
 * Mentak Coalition "S'ula Mentarion" (commander): "After you win a
 * space combat: You may force your opponent to give you 1 promissory
 * note from their hand." Unlock: "Have 4 cruisers on the game board."
 * Confirmed (yjmrobert.com/tirules/factions/f_mentak): a "force to
 * give" effect — NOT a transaction (matches PILLAGE's own ruling #2
 * about this exact card), and does not itself trigger PILLAGE against
 * the target as a result.
 */
export function useSUlaMentarion(
  state: GameState,
  action: { type: "USE_SULA_MENTARION"; playerId: PlayerId; opponentId: PlayerId; promissoryNoteId: string },
): ActionResult {
  const player = state.players[action.playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("mentak_commander" as never));
  if (!commanderEntry || commanderEntry.locked) return { ok: false, error: "This player doesn't have an unlocked S'ula Mentarion." };

  const opponent = state.players[action.opponentId];
  if (!opponent.promissoryNotesInHand.includes(action.promissoryNoteId as never)) {
    return { ok: false, error: "That player doesn't have that promissory note in hand." };
  }

  const updatedOpponent: Player = { ...opponent, promissoryNotesInHand: opponent.promissoryNotesInHand.filter((id) => id !== (action.promissoryNoteId as never)) };
  const updatedPlayer: Player = { ...player, promissoryNotesInHand: [...player.promissoryNotesInHand, action.promissoryNoteId as never] };

  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [action.opponentId]: updatedOpponent } }, events: [] };
}

/**
 * Mentak Coalition "Ipswitch, Loose Cannon — SLEEPER CELL" (hero,
 * single-use): the ACTIVATION half — "At the start of space combat that
 * you are participating in: You may purge this card." Confirmed
 * (yjmrobert.com/tirules/factions/f_mentak): "the Mentak player can
 * trigger Sleeper Cell, their Ambush ability, or any other 'at the
 * start of a space combat' ability in any order" — no forced sequencing
 * with useAmbush above, both just check pending.combatRound === 1
 * independently. Sets a flag consumed round-by-round below by
 * resolveSleeperCellPlacement; the actual replacements only happen
 * AFTER this is active AND a round's hits have been assigned.
 */
export function useSleeperCell(state: GameState, action: { type: "USE_SLEEPER_CELL"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("mentak_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Ipswitch, Loose Cannon." };
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat" || pending.combatRound !== 1) {
    return { ok: false, error: "SLEEPER CELL is only usable at the start of space combat." };
  }

  const updatedPlayer: Player = { ...player, leaders: player.leaders.filter((l) => l.leaderId !== ("mentak_hero" as never)) };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, pendingTacticalAction: { ...pending, sleeperCellActive: true } },
    events: [],
  };
}

/**
 * "SLEEPER CELL": the placement half — "for each other player's ship
 * that is destroyed during this combat, place 1 ship of that type from
 * your reinforcements in the active system." Confirmed
 * (yjmrobert.com/tirules/factions/f_mentak):
 *  - "Ships destroyed BEFORE Sleeper Cell is triggered" don't count —
 *    handled naturally since this function only ever gets called by the
 *    caller AFTER useSleeperCell has set the flag (any destruction
 *    before that never reaches this code path at all).
 *  - "Both players choose/destroy for EACH hit before the Mentak player
 *    places their Sleeper Cell replacement" — this function is only
 *    meant to be invoked AFTER hit assignment for a round is fully
 *    resolved on both sides, per this project's own established
 *    "resolved AFTER the round" convention for similar reactive
 *    abilities (Harrow, etc.).
 *  - "The Mentak player may place a ship destroyed in the SAME round of
 *    combat... EVEN IF they had none of that ship type in their
 *    reinforcements" — this confirms reinforcements are NEVER checked
 *    for this placement at all (a genuine exception; most other "steal
 *    from elsewhere" patterns in this project still require SOME
 *    source — this one requires none).
 *  - "Fleet pool limits still apply during combat. However, if the
 *    Mentak player is at their fleet pool limit, they may still place a
 *    unit using this ability, but must then immediately remove a unit.
 *    Capacity is not checked during combat." — modeled as: placement
 *    always succeeds; if it pushes the player over their own fleet
 *    pool, the caller must submit a companion removedUnitType/removedSystemId
 *    to immediately remove 1 non-fighter ship from somewhere, enforced
 *    here rather than left to trust.
 *  - Cannot place a war sun without owning war sun technology.
 *  - If Direct Hit destroys a ship, the replacement decision for THAT
 *    hit happens immediately, before any other ship's own Sustain
 *    Damage — a sequencing nuance this project's own turn-based action
 *    model doesn't need special code for for (the caller simply submits
 *    this action at the right point, same "trusted timing" convention
 *    as elsewhere).
 *  - If the replacement ship type itself has Sustain Damage, it may use
 *    it later in the SAME round — no special handling needed, since the
 *    newly-placed unit is just a normal stack entry from here on.
 */
export function resolveSleeperCellPlacement(
  state: GameState,
  action: {
    type: "RESOLVE_SLEEPER_CELL_PLACEMENT";
    playerId: PlayerId;
    destroyedOpponentUnitTypes: import("../types/enums").UnitType[];
    removals?: { unitType: import("../types/enums").UnitType; count: number }[];
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending?.sleeperCellActive || pending.playerId !== action.playerId) {
    return { ok: false, error: "SLEEPER CELL isn't active for this player right now." };
  }
  const player = state.players[action.playerId];
  const systemId = pending.systemId;

  for (const unitType of action.destroyedOpponentUnitTypes) {
    if (unitType === "war_sun" && !player.technologies.includes("war_sun" as never)) {
      return { ok: false, error: "Cannot place a War Sun without War Sun technology, even via SLEEPER CELL." };
    }
  }

  let system = state.systems[systemId];
  let stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  for (const unitType of action.destroyedOpponentUnitTypes) {
    const existing = stacks.find((s) => s.unitType === unitType);
    if (existing) existing.count += 1;
    else stacks.push({ unitType, count: 1, damagedCount: 0 });
  }

  if (action.removals && action.removals.length > 0) {
    for (const { unitType, count } of action.removals) {
      const stack = stacks.find((s) => s.unitType === unitType);
      if (!stack || stack.count < count) return { ok: false, error: `Not enough ${unitType} to remove ${count}.` };
      stack.count -= count;
    }
    stacks = stacks.filter((s) => s.count > 0);
  }

  const nonFighterCount = stacks.filter((s) => s.unitType !== "fighter").reduce((sum, s) => sum + s.count, 0);
  const maxAllowed = getMaxNonFighterShips(player);
  if (nonFighterCount > maxAllowed) {
    return { ok: false, error: `SLEEPER CELL: this would put this player at ${nonFighterCount} non-fighter ships, over their own fleet pool of ${maxAllowed} — submit companion removals to bring it back down immediately.` };
  }

  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: stacks } };
  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [systemId]: updatedSystem } },
    events: action.destroyedOpponentUnitTypes.map((unitType) => ({ type: "UNITS_PRODUCED" as const, playerId: action.playerId, systemId, unitType, count: 1, totalCost: 0 })),
  };
}

/**
 * Mentak Coalition "The Table's Grace" (Breakthrough ability): "If you
 * have the Cruiser II unit upgrade technology, flip this card and place
 * it on top of Cruiser II. Corsair: Cost 2, Combat 6, Move 3, Capacity
 * 2. If the active system contains another player's non-fighter ships,
 * this unit can move through systems that contain other players'
 * ships."
 *
 * ARCHITECTURAL NOTE: this project's own getUnitStats(rules, factionId,
 * unitType, ownedUpgradeIds) has no PLAYER context at all (faction +
 * upgrade ids only), so it can't itself branch on hasBreakthrough. This
 * wrapper is the targeted fix — callers that need Mentak's own
 * Cruiser-II-vs-Corsair distinction use THIS instead of getUnitStats
 * directly. Only Capacity actually differs (2 instead of 3); Cost/
 * Combat/Move are identical to Cruiser II already, so those needed no
 * separate override.
 *
 * KNOWN SCOPE LIMIT: the "may move through systems containing other
 * players' ships" ability itself is NOT wired into this project's own
 * movement validation (rules/movement.ts's own canShipReachSystem and
 * whatever blocks passage through hostile systems) — that's deeper
 * surgery than this pass covers, flagged rather than silently ignored.
 * The stat correction (capacity 2, not 3) IS applied everywhere this
 * wrapper is actually used.
 */
export function getMentakCruiserStats(rules: RuleData, player: Player): ReturnType<typeof getUnitStats> {
  const base = getUnitStats(rules, player.factionId, "cruiser", player.unitUpgrades);
  if (!base) return base;
  const isCorsair = player.factionId === ("mentak" as never) && player.hasBreakthrough && player.technologies.includes("cruiser_2" as never);
  if (!isCorsair) return base;
  return { ...base, capacity: 2 };
}
