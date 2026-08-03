import { GameState, Player } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PromissoryNoteId, asAbilityId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { arePlayersNeighbors } from "./adjacency";
import { actionPhaseWindowOrder } from "./priorityWindow";
import { spaceStationsControlledBy } from "./spaceStations";
import { hasAbility } from "./abilities";

type RelicFragmentType = "cultural" | "industrial" | "hazardous" | "unknown";

/** Canonical, order-independent key for a pair of players — used to track "have these 2 already transacted this turn/agenda" regardless of which one initiates. */
function pairKey(a: PlayerId, b: PlayerId): string {
  return [a, b].sort().join("|");
}

/**
 * RR (yjmrobert.com/tirules/rules/r_transactions): can these 2 players
 * transact right now? Either they're neighbors (RR "Neighbors" — see
 * adjacency.ts's own arePlayersNeighbors, now fixed to also check unit
 * presence, not just planet control), or TE SPACE STATIONS' own
 * exception applies ("a player that controls a space station can
 * resolve transactions with other players that control a space
 * station, even if they are not neighbors").
 *
 * During the AGENDA phase specifically, the normal neighbor requirement
 * is dropped entirely — confirmed: "while resolving each agenda...
 * players do not need to be neighbors to perform these transactions" —
 * capped at 1 per agenda per pair instead of 1 per turn per pair.
 */
export function canTransact(state: GameState, playerIdA: PlayerId, playerIdB: PlayerId, rules: RuleData): { ok: true } | { ok: false; error: string } {
  if (playerIdA === playerIdB) return { ok: false, error: "A player cannot transact with themselves." };
  const key = pairKey(playerIdA, playerIdB);

  if (state.phase === "agenda") {
    if ((state.transactionsThisAgenda ?? []).includes(key)) {
      return { ok: false, error: "These 2 players already transacted during this agenda." };
    }
    return { ok: true };
  }

  const isNeighbors = arePlayersNeighbors(state, playerIdA, playerIdB, rules);
  const bothHaveSpaceStations = spaceStationsControlledBy(state, playerIdA).length > 0 && spaceStationsControlledBy(state, playerIdB).length > 0;
  // Hacan "GUILD SHIPS" (faction ability, passive) / "Trade Convoys" (promissory note, placed face-up in a player's own play area): "You can negotiate transactions with players who are not your neighbor." Confirmed (tirules2.com/F_hacan): doesn't make Hacan neighbors with EVERYONE (just bypasses the neighbor requirement for THIS check specifically); either player may initiate; still limited to 1 transaction per pair per turn (the check right below this one is untouched).
  const guildShipsOrTradeConvoysActive =
    hasAbility(state.players[playerIdA], asAbilityId("guild_ships")) ||
    hasAbility(state.players[playerIdB], asAbilityId("guild_ships")) ||
    (state.players[playerIdA]?.promissoryNotesInPlayArea ?? []).includes("hacan_promissory" as never) ||
    (state.players[playerIdB]?.promissoryNotesInPlayArea ?? []).includes("hacan_promissory" as never);
  if (!isNeighbors && !bothHaveSpaceStations && !guildShipsOrTradeConvoysActive) {
    return { ok: false, error: "These 2 players are not neighbors (and don't both control a space station)." };
  }
  if ((state.transactionsThisTurn ?? []).includes(key)) {
    return { ok: false, error: "These 2 players already transacted this turn." };
  }
  return { ok: true };
}

interface TransactionOffer {
  tradeGoods?: number;
  commodities?: number;
  promissoryNoteId?: PromissoryNoteId;
  relicFragments?: Partial<Record<RelicFragmentType, number>>;
  /** RR "Capture": "Captured units may be returned to the player that originally owned them as part of a transaction." Only meaningful on the GIVING side, and only for non-fighter/non-infantry captured units (RR 17.4a: captured fighters/infantry are generic, ownerless tokens and cannot be returned this way). Returns to the original owner's reinforcements — there's no board location to place it at, so this just removes it from the giver's own capturedUnits list. */
  returnedCapturedUnitType?: import("../types/enums").UnitType;
  /** TE "Black Market Dealings": "you and the other player can include relics, action cards, and unscored secret objectives as part of the transaction" — only valid when action.blackMarketDealings is true on the SAME PROPOSE_TRANSACTION this offer is part of; rejected otherwise (see resolveTransaction's own validation). */
  relicId?: import("../types/ids").RelicId;
  actionCardId?: string;
  unscoredSecretObjectiveId?: string;
  /** Hacan "ARBITERS" (faction ability, passive): "action cards can be exchanged as part of a transaction" — ANY NUMBER, unlike Black Market Dealings' own singular actionCardId above (that one's TE-specific and doesn't require either side to actually be Hacan). Confirmed (tirules2.com/F_hacan): "any number of action cards may be traded"; a receiver may go OVER the 7-card hand limit as a result, but must immediately discard back down to 7 (discardExcessActionCardIds below, the RECEIVING player's own choice of which). */
  actionCardIds?: string[];
  /** Only meaningful alongside actionCardIds above, on the RECEIVING side of an ARBITERS trade that would push them over 7 action cards — their own choice of which excess ones to discard, applied immediately after receiving. */
  discardExcessActionCardIds?: string[];
  /** Hacan "Pride of Kenara" (mech, Tradeable Planet): "this planet's card may be traded as part of a transaction; if you do, move all of your units from this planet to another planet you control." Confirmed (tirules2.com/F_hacan): structures move too (not just ground forces); cannot be traded DURING combat; if the planet is in a gravity rift, moved units must roll for removal (KNOWN GAP: not implemented here — this project has no generic gravity-rift-removal-roll wiring for planet-to-planet moves like this one, same category of gap as a few other gravity-rift edge cases elsewhere). Only meaningful on the GIVING side. */
  tradeablePlanetId?: import("../types/ids").PlanetId;
  /** Required alongside tradeablePlanetId above — which OTHER planet the giver's units move to; must already be controlled by the giver. */
  tradeablePlanetMoveToPlanetId?: import("../types/ids").PlanetId;
}

/**
 * RR (yjmrobert.com/tirules/rules/r_transactions): "a player gives any
 * number of trade goods and commodities and up to one promissory note
 * to a neighbor in exchange for any number of trade goods, commodities,
 * and relic fragments, and up to one promissory note." Modeled
 * symmetrically here (either side's own offer can include relic
 * fragments too) — the confirmed notes ("relic fragments may be traded")
 * don't restrict this to only one direction, and PoK's own addition of
 * relic fragments to transactions was never phrased as one-directional
 * in the first place.
 *
 * Since a real transaction is negotiated out loud between 2 people
 * before anything changes hands, this action represents the AGREED
 * outcome in one atomic step (matching this project's own established
 * pattern for other mutual-consent moments, e.g. TE COEXIST's own
 * choices) — whichever of the 2 players submits it, both sides' offers
 * are included in the same payload.
 */
export function resolveTransaction(
  state: GameState,
  action: {
    type: "PROPOSE_TRANSACTION";
    playerId: PlayerId;
    withPlayerId: PlayerId;
    offer: TransactionOffer;
    request: TransactionOffer;
    /** TE "Black Market Dealings": if true, this player is spending that card (from their own hand) as PART of this same transaction, unlocking relics/action cards/unscored secret objectives on EITHER side's offer. Consumed here directly rather than through the normal PLAY_<CARD>/Sabotage-interception flow — the card's own "this card cannot be cancelled" line means it was never eligible for that announce-then-maybe-cancel mechanism in the first place (see GameEngine.ts's own COMPONENT_ACTION_CARD_IDS-adjacent exclusion list). */
    blackMarketDealings?: boolean;
  },
  rules: RuleData,
): ActionResult {
  const check = canTransact(state, action.playerId, action.withPlayerId, rules);
  if (!check.ok) return { ok: false, error: check.error };

  const eitherPlayerHasArbiters = hasAbility(state.players[action.playerId], asAbilityId("arbiters")) || hasAbility(state.players[action.withPlayerId], asAbilityId("arbiters"));
  if (!action.blackMarketDealings) {
    const usesWideItems = (o: TransactionOffer) => o.relicId || o.actionCardId || o.unscoredSecretObjectiveId;
    if (usesWideItems(action.offer) || usesWideItems(action.request)) {
      return { ok: false, error: 'TE "Black Market Dealings": relics, action cards, and unscored secret objectives can only be included in a transaction when this card is played as part of it.' };
    }
    if ((action.offer.actionCardIds?.length || action.request.actionCardIds?.length) && !eitherPlayerHasArbiters) {
      return { ok: false, error: 'Hacan "ARBITERS": action cards can only be exchanged in a transaction if one of the 2 players has this ability.' };
    }
  } else {
    const caster = state.players[action.playerId];
    if (!caster?.actionCards.includes("black_market_dealings" as never)) {
      return { ok: false, error: 'This player does not have "Black Market Dealings" in hand.' };
    }
  }

  const player = state.players[action.playerId];
  const other = state.players[action.withPlayerId];
  if (!player || !other) return { ok: false, error: "Unknown player." };

  let updatedPlayer = player;
  let updatedOther = other;
  const events: GameEvent[] = [];

  const applyOffer = (giver: Player, receiver: Player, offer: TransactionOffer): { giver: Player; receiver: Player } | { error: string } => {
    let g = giver;
    let r = receiver;

    if (offer.tradeGoods) {
      if (g.tradeGoods < offer.tradeGoods) return { error: `${g.id} doesn't have ${offer.tradeGoods} trade goods.` };
      g = { ...g, tradeGoods: g.tradeGoods - offer.tradeGoods };
      r = { ...r, tradeGoods: r.tradeGoods + offer.tradeGoods };
    }
    if (offer.commodities) {
      if (g.commodities < offer.commodities) return { error: `${g.id} doesn't have ${offer.commodities} commodities.` };
      // RR 21.5/21.6: a commodity given to another player converts into a trade good for the RECEIVER — it is never received as a commodity.
      g = { ...g, commodities: g.commodities - offer.commodities };
      r = { ...r, tradeGoods: r.tradeGoods + offer.commodities };
    }
    if (offer.promissoryNoteId) {
      if (!g.promissoryNotesInHand.includes(offer.promissoryNoteId)) return { error: `${g.id} doesn't have that promissory note.` };
      g = { ...g, promissoryNotesInHand: g.promissoryNotesInHand.filter((id) => id !== offer.promissoryNoteId) };
      r = { ...r, promissoryNotesInHand: [...r.promissoryNotesInHand, offer.promissoryNoteId] };
    }
    if (offer.relicFragments) {
      for (const [type, count] of Object.entries(offer.relicFragments) as [RelicFragmentType, number][]) {
        if (!count) continue;
        if (g.relicFragments[type] < count) return { error: `${g.id} doesn't have ${count} ${type} relic fragments.` };
        g = { ...g, relicFragments: { ...g.relicFragments, [type]: g.relicFragments[type] - count } };
        r = { ...r, relicFragments: { ...r.relicFragments, [type]: r.relicFragments[type] + count } };
      }
    }
    if (offer.returnedCapturedUnitType) {
      // RR "Capture" 17.1/17.2a: "the unit is returned... it is placed into the reinforcements of the original owner" — there's no specific board location to place it, so simply removing it from the giver's own capturedUnits already IS the full effect (it stops counting against the original owner's reinforcement cap, per checkReinforcementsAvailable's own accounting).
      // RR 17.4a: captured fighters/infantry are generic tokens, not owner-specific, and CANNOT be returned as part of a transaction — only non-fighter ships and mechs qualify.
      const unitType = offer.returnedCapturedUnitType;
      if (unitType === "fighter" || unitType === "infantry") {
        return { error: "Captured fighters/infantry cannot be returned as part of a transaction." };
      }
      const entry = g.capturedUnits.find((c) => c.unitType === unitType && c.fromPlayerId === r.id && c.count > 0);
      if (!entry) return { error: `${g.id} hasn't captured a ${unitType} from ${r.id}.` };
      g = { ...g, capturedUnits: g.capturedUnits.map((c) => (c === entry ? { ...c, count: c.count - 1 } : c)).filter((c) => c.count > 0) };
    }
    if (offer.relicId) {
      if (!g.relics.includes(offer.relicId)) return { error: `${g.id} doesn't have that relic.` };
      g = { ...g, relics: g.relics.filter((id) => id !== offer.relicId) };
      r = { ...r, relics: [...r.relics, offer.relicId] };
    }
    if (offer.actionCardId) {
      if (!g.actionCards.includes(offer.actionCardId as never)) return { error: `${g.id} doesn't have that action card.` };
      g = { ...g, actionCards: g.actionCards.filter((id) => id !== offer.actionCardId) as never };
      r = { ...r, actionCards: [...r.actionCards, offer.actionCardId] as never };
    }
    if (offer.actionCardIds && offer.actionCardIds.length > 0) {
      for (const cardId of offer.actionCardIds) {
        if (!g.actionCards.includes(cardId as never)) return { error: `${g.id} doesn't have ${cardId}.` };
      }
      g = { ...g, actionCards: g.actionCards.filter((id) => !offer.actionCardIds!.includes(id)) as never };
      r = { ...r, actionCards: [...r.actionCards, ...offer.actionCardIds] as never };
      // Hacan "ARBITERS": "a player may receive action cards even if doing so would put them over the 7 action card hand limit; they must immediately discard down to 7." The RECEIVER'S OWN choice of which — required here if this pushes them over.
      if (r.actionCards.length > 7) {
        const toDiscard = offer.discardExcessActionCardIds ?? [];
        if (toDiscard.length !== r.actionCards.length - 7) {
          return { error: `${r.id} would have ${r.actionCards.length} action cards (limit 7) — discardExcessActionCardIds must specify exactly ${r.actionCards.length - 7} to discard.` };
        }
        for (const cardId of toDiscard) {
          if (!r.actionCards.includes(cardId as never)) return { error: `${r.id} doesn't have ${cardId} to discard.` };
        }
        r = { ...r, actionCards: r.actionCards.filter((id) => !toDiscard.includes(id)) as never };
      }
    }
    if (offer.unscoredSecretObjectiveId) {
      if (!g.secretObjectives.includes(offer.unscoredSecretObjectiveId as never) || g.victoryPoints.scoredObjectiveIds.includes(offer.unscoredSecretObjectiveId as never)) {
        return { error: `${g.id} doesn't have that UNSCORED secret objective.` };
      }
      g = { ...g, secretObjectives: g.secretObjectives.filter((id) => id !== offer.unscoredSecretObjectiveId) as never };
      r = { ...r, secretObjectives: [...r.secretObjectives, offer.unscoredSecretObjectiveId] as never };
    }
    return { giver: g, receiver: r };
  };

  const step1 = applyOffer(updatedPlayer, updatedOther, action.offer);
  if ("error" in step1) return { ok: false, error: step1.error };
  updatedPlayer = step1.giver;
  updatedOther = step1.receiver;

  const step2 = applyOffer(updatedOther, updatedPlayer, action.request);
  if ("error" in step2) return { ok: false, error: step2.error };
  updatedOther = step2.giver;
  updatedPlayer = step2.receiver;

  if (action.blackMarketDealings) {
    updatedPlayer = { ...updatedPlayer, actionCards: updatedPlayer.actionCards.filter((id) => id !== "black_market_dealings") as never };
  }

  const key = pairKey(action.playerId, action.withPlayerId);
  let nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer, [action.withPlayerId]: updatedOther },
    transactionsThisTurn: state.phase === "agenda" ? state.transactionsThisTurn : [...(state.transactionsThisTurn ?? []), key],
    transactionsThisAgenda: state.phase === "agenda" ? [...(state.transactionsThisAgenda ?? []), key] : state.transactionsThisAgenda,
  };
  events.push({ type: "TRANSACTION_RESOLVED", playerId: action.playerId, otherPlayerId: action.withPlayerId });

  // Hacan "Pride of Kenara" (mech, Tradeable Planet): "move all of your units from this planet to another planet you control." Checked for BOTH sides of the transaction (either the offer or the request could include it) — validated here (not inside applyOffer, which only has Player objects, not the full board) since this operates on systems/planets directly.
  for (const [giverId, offer] of [[action.playerId, action.offer], [action.withPlayerId, action.request]] as [PlayerId, TransactionOffer][]) {
    if (!offer.tradeablePlanetId) continue;
    if (nextState.pendingTacticalAction && (nextState.pendingTacticalAction.step === "spaceCombat" || nextState.pendingTacticalAction.step === "invasion")) {
      return { ok: false, error: "Pride of Kenara: cannot trade a planet during combat." };
    }
    type FoundPlanet = { systemId: import("../types/ids").SystemId; system: import("../types/GameState").SystemState; planet: import("../types/GameState").PlanetState };
    let sourceFound: FoundPlanet | null = null;
    let destFound: FoundPlanet | null = null;
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      const sourcePlanet = system.planets.find((p) => p.planetId === offer.tradeablePlanetId);
      if (sourcePlanet) sourceFound = { systemId: systemId as import("../types/ids").SystemId, system, planet: sourcePlanet };
      const destPlanet = system.planets.find((p) => p.planetId === offer.tradeablePlanetMoveToPlanetId);
      if (destPlanet) destFound = { systemId: systemId as import("../types/ids").SystemId, system, planet: destPlanet };
    }
    if (!sourceFound || sourceFound.planet.controllerId !== giverId) return { ok: false, error: "That player doesn't control the tradeable planet." };
    if (!destFound || destFound.planet.controllerId !== giverId) return { ok: false, error: "That player doesn't control the destination planet." };
    const hasPrideOfKenaraHere = (sourceFound.planet.unitsByPlayer[giverId] ?? []).some((s) => s.unitType === "mech" && s.count > 0) && nextState.players[giverId]?.factionId === ("hacan" as never);
    if (!hasPrideOfKenaraHere) return { ok: false, error: "Pride of Kenara: that player doesn't have this mech on the planet being traded." };

    const movedStacks = sourceFound.planet.unitsByPlayer[giverId] ?? [];
    const destStacks = destFound.planet.unitsByPlayer[giverId] ?? [];
    const mergedStacks = [...destStacks];
    for (const stack of movedStacks) {
      const existing = mergedStacks.find((s) => s.unitType === stack.unitType);
      if (existing) existing.count += stack.count;
      else mergedStacks.push({ ...stack });
    }
    const updatedSourcePlanet = { ...sourceFound.planet, unitsByPlayer: { ...sourceFound.planet.unitsByPlayer, [giverId]: [] } };
    const updatedSourceSystem = { ...sourceFound.system, planets: sourceFound.system.planets.map((p) => (p.planetId === offer.tradeablePlanetId ? updatedSourcePlanet : p)) };
    let systems = { ...nextState.systems, [sourceFound.systemId]: updatedSourceSystem };
    const destSystemAfterSourceUpdate = sourceFound.systemId === destFound.systemId ? updatedSourceSystem : destFound.system;
    const updatedDestPlanet = { ...destFound.planet, unitsByPlayer: { ...destFound.planet.unitsByPlayer, [giverId]: mergedStacks } };
    systems = { ...systems, [destFound.systemId]: { ...destSystemAfterSourceUpdate, planets: destSystemAfterSourceUpdate.planets.map((p) => (p.planetId === offer.tradeablePlanetMoveToPlanetId ? updatedDestPlanet : p)) } };
    nextState = { ...nextState, systems };
  }

  // TE "Lie in Wait": "After 2 of your neighbours resolve a transaction"
  // — checked for every OTHER player who is a neighbor of BOTH parties to
  // THIS transaction (the 2 who just transacted don't count as "their
  // own" neighbours reacting to themselves). No strict priority order is
  // specified by the card itself; uses actionPhaseWindowOrder the same
  // way most other reactive windows in this project do, for consistency.
  const lieInWaitEligible = Object.keys(nextState.players).filter(
    (id) =>
      id !== action.playerId &&
      id !== action.withPlayerId &&
      !nextState.players[id as PlayerId]?.eliminated &&
      arePlayersNeighbors(nextState, id as PlayerId, action.playerId, rules) &&
      arePlayersNeighbors(nextState, id as PlayerId, action.withPlayerId, rules),
  ) as PlayerId[];
  if (lieInWaitEligible.length > 0) {
    const order = actionPhaseWindowOrder(nextState, action.playerId, lieInWaitEligible);
    if (order.length > 0) {
      nextState = {
        ...nextState,
        pendingPriorityWindow: { kind: "after_transaction_resolved", order, currentIndex: 0, consecutivePasses: 0 },
        pendingLieInWaitTargets: [action.playerId, action.withPlayerId],
      };
    }
  }

  return { ok: true, state: nextState, events };
}
