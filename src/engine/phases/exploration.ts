import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, ExplorationCardId, asTechId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { hasPoKContent } from "../rules/gameMode";
import { fisherYatesShuffle } from "../setup/mapGeneration";

/**
 * RR 35 EXPLORATION + RR 75 RELICS.
 *
 * Card draws are deterministic pops off a pre-shuffled deck array (same
 * pattern as actionCardDeck/publicObjectiveDeck elsewhere) — no mid-game
 * RNG concern for the initial shuffle; drawExplorationCard below handles
 * the RR 35.7a reshuffle-on-empty case with its own rng, same convention
 * as phases/actionCards.ts's drawActionCard.
 *
 * Mechanically applied when a card is drawn: Relic Fragment (increments the
 * right counter), Attach (pushed to the planet's attachmentIds — numeric
 * bonuses read later via rules/planetStats.ts), Keep In Play Area (pushed
 * to the player's own list). A plain one-time `effect` (no fragment/attach/
 * keepInPlayArea flag) is NOT applied — same deferred-content scope cut as
 * action/agenda cards. RR 35.7: only THIS last "plain" kind actually enters
 * a discard pile at all — relic fragments/attachments/keepInPlayArea cards
 * stay with the player/planet instead, same as the physical cards would.
 *
 * NOT implemented, flagged rather than silently wrong:
 *  - RR 35's own "choose order if multiple explorations happen at once" isn't enforced.
 *  - Frontier tokens' OTHER trigger condition (moving a ship into a system
 *    with a frontier token and no other players' ships) isn't validated —
 *    EXPLORE_FRONTIER just checks the token is there.
 *
 * RR 25.1c automatic exploration (the ONLY way a planet is explored per
 * the actual rules — "when a player takes control of a planet that is
 * not already controlled by another player, they explore that planet")
 * lives in phases/invasion.ts's own setPlanetController, not here. There
 * is no standalone "explore an already-controlled-but-unexplored
 * planet" action — that scenario doesn't exist in the rules; a
 * controlled planet is always either already explored (control gained
 * from another player, or re-explored via a specific ability like
 * Scanlink Drone Network below) or gets explored automatically the
 * instant control is first established. An EXPLORE_PLANET action used
 * to exist here representing that non-existent scenario; removed.
 */

/** RR 35.7a: pop the top card of this exploration deck, reshuffling its own discard pile into a fresh deck first if it's empty — same shared shape as phases/actionCards.ts's drawActionCard. Exported so phases/technologyAbilities.ts's Scanlink Drone Network can reuse the exact same reshuffle-aware draw. */
export function drawExplorationCard(deck: ExplorationCardId[], discardPile: ExplorationCardId[], rng: () => number = Math.random): { deck: ExplorationCardId[]; discardPile: ExplorationCardId[]; drawn: ExplorationCardId | null } {
  let workingDeck = deck;
  let workingDiscard = discardPile;
  if (workingDeck.length === 0 && workingDiscard.length > 0) {
    workingDeck = fisherYatesShuffle(workingDiscard, rng);
    workingDiscard = [];
  }
  if (workingDeck.length === 0) return { deck: workingDeck, discardPile: workingDiscard, drawn: null };
  const [drawn, ...rest] = workingDeck;
  return { deck: rest, discardPile: workingDiscard, drawn };
}

export function exploreFrontier(
  state: GameState,
  action: { type: "EXPLORE_FRONTIER"; playerId: PlayerId; systemId: SystemId },
  rules: RuleData,
): ActionResult {
  if (!hasPoKContent(state.mode)) {
    return { ok: false, error: "RR 35: Frontier tokens are a Prophecy of Kings mechanic, not available without Prophecy of Kings + Codex content (base-only or Thunder's-Edge-only games)." };
  }
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (!system.frontierToken) return { ok: false, error: `RR 35: ${action.systemId} has no frontier token.` };
  if (!state.players[action.playerId]?.technologies.includes(asTechId("dark_energy_tap"))) {
    return { ok: false, error: "RR 35: exploring a frontier token requires owning the Dark Energy Tap technology." };
  }

  const deck = state.explorationDecks?.frontier ?? [];
  const discardPile = state.explorationDiscardPiles?.frontier ?? [];
  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [action.systemId]: { ...system, frontierToken: false } },
  };
  const events: GameEvent[] = [];

  const drawResult = drawExplorationCard(deck, discardPile);
  if (drawResult.drawn) {
    const cardId = drawResult.drawn;
    const result = applyExplorationCard(nextState, action.playerId, action.systemId, null, cardId, rules);
    nextState = result.state;
    events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: "frontier" });
    const card = rules.explorationCards[cardId];
    const goesToDiscard = !card?.isRelicFragment && !card?.attach && !card?.keepInPlayArea;
    nextState = {
      ...nextState,
      explorationDecks: { ...nextState.explorationDecks!, frontier: drawResult.deck },
      explorationDiscardPiles: { ...nextState.explorationDiscardPiles, frontier: goesToDiscard ? [...drawResult.discardPile, cardId] : drawResult.discardPile } as GameState["explorationDiscardPiles"],
    };
  }

  return { ok: true, state: nextState, events };
}

/** Shared mechanical draw resolution — `planetId` is null for frontier draws (no planet to attach to). Exported so phases/technologyAbilities.ts's Sling Relay can reuse the exact same draw/apply logic (it triggers an exploration through a different door — a tech ability, not RR 35's normal "gained control" or "frontier token" triggers — but the card draw itself works identically either way). */
export function applyExplorationCard(
  state: GameState,
  playerId: PlayerId,
  systemId: SystemId,
  planetId: PlanetId | null,
  cardId: string,
  rules: RuleData,
): { state: GameState; events: GameEvent[] } {
  const card = rules.explorationCards[cardId];
  if (!card) return { state, events: [] };

  const player = state.players[playerId];
  let nextState = state;
  const events: GameEvent[] = [];

  if (card.isRelicFragment && card.fragmentType) {
    const key = card.fragmentType === "any" ? "unknown" : card.fragmentType;
    nextState = {
      ...nextState,
      players: {
        ...nextState.players,
        [playerId]: { ...player, relicFragments: { ...player.relicFragments, [key]: player.relicFragments[key] + 1 } },
      },
    };
    events.push({ type: "RELIC_FRAGMENT_GAINED", playerId, fragmentType: card.fragmentType });
  } else if (card.attach && planetId) {
    const system = nextState.systems[systemId];
    const updatedPlanet: PlanetState = {
      ...system.planets.find((p) => p.planetId === planetId)!,
      attachmentIds: [...system.planets.find((p) => p.planetId === planetId)!.attachmentIds, cardId],
    };
    const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) };
    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: updatedSystem } };
  } else if (card.keepInPlayArea) {
    nextState = {
      ...nextState,
      players: {
        ...nextState.players,
        [playerId]: { ...nextState.players[playerId], explorationCardsInPlayArea: [...nextState.players[playerId].explorationCardsInPlayArea, cardId as never] },
      },
    };
  }
  // Plain one-time effect: card is consumed (already popped by the caller), no further state change — see this file's own scope note.

  return { state: nextState, events };
}

function setExplored(state: GameState, systemId: SystemId, planetId: PlanetId): GameState {
  const system = state.systems[systemId];
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, explored: true } : p)),
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}

export function purgeRelicFragments(
  state: GameState,
  action: {
    type: "PURGE_RELIC_FRAGMENTS";
    playerId: PlayerId;
    fragmentType: "cultural" | "industrial" | "hazardous";
    useCount: number;
    useUnknownCount: number;
  },
): ActionResult {
  if (!hasPoKContent(state.mode)) {
    return { ok: false, error: "RR 35.9: Relics are a Prophecy of Kings mechanic, not available without Prophecy of Kings + Codex content (base-only or Thunder's-Edge-only games)." };
  }
  if (action.useCount + action.useUnknownCount !== 3) {
    return { ok: false, error: "RR 35.9: purging a relic needs exactly 3 fragments total (same type + any Unknown substituting)." };
  }
  const player = state.players[action.playerId];
  if (player.relicFragments[action.fragmentType] < action.useCount) {
    return { ok: false, error: `Not enough ${action.fragmentType} fragments.` };
  }
  if (player.relicFragments.unknown < action.useUnknownCount) {
    return { ok: false, error: "Not enough Unknown fragments." };
  }
  const deck = state.relicDeck ?? [];
  if (deck.length === 0) return { ok: false, error: "The relic deck is empty." };

  const [relicId, ...rest] = deck;
  const updatedPlayer: Player = {
    ...player,
    relicFragments: {
      ...player.relicFragments,
      [action.fragmentType]: player.relicFragments[action.fragmentType] - action.useCount,
      unknown: player.relicFragments.unknown - action.useUnknownCount,
    },
    relics: [...player.relics, relicId],
  };

  return {
    ok: true,
    state: { ...state, relicDeck: rest, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "RELIC_GAINED", playerId: action.playerId, relicId }],
  };
}
