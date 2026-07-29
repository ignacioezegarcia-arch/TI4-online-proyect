import { GameState, Player } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PromissoryNoteId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { arePlayersNeighbors } from "./adjacency";
import { actionPhaseWindowOrder } from "./priorityWindow";
import { spaceStationsControlledBy } from "./spaceStations";

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
  if (!isNeighbors && !bothHaveSpaceStations) {
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

  if (!action.blackMarketDealings) {
    const usesWideItems = (o: TransactionOffer) => o.relicId || o.actionCardId || o.unscoredSecretObjectiveId;
    if (usesWideItems(action.offer) || usesWideItems(action.request)) {
      return { ok: false, error: 'TE "Black Market Dealings": relics, action cards, and unscored secret objectives can only be included in a transaction when this card is played as part of it.' };
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
