import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asTechId } from "../types/ids";
import { RuleData } from "../types/RuleData";

/**
 * RR 35 EXPLORATION + RR 75 RELICS.
 *
 * Card draws are deterministic pops off a pre-shuffled deck array (same
 * pattern as actionCardDeck/publicObjectiveDeck elsewhere) — no mid-game
 * RNG concern.
 *
 * Mechanically applied when a card is drawn: Relic Fragment (increments the
 * right counter), Attach (pushed to the planet's attachmentIds — numeric
 * bonuses read later via rules/planetStats.ts), Keep In Play Area (pushed
 * to the player's own list). A plain one-time `effect` (no fragment/attach/
 * keepInPlayArea flag) is NOT applied — same deferred-content scope cut as
 * action/agenda cards, since the effect text is free-form. The card is
 * still consumed (discarded) either way; only its mechanical side-effect
 * might be a no-op.
 *
 * NOT implemented, flagged rather than silently wrong:
 *  - RR 35's exact timing (must explore immediately on gaining control,
 *    choose order if multiple at once) isn't enforced — EXPLORE_PLANET is
 *    legal any time the planet is controlled and unexplored.
 *  - Frontier tokens' OTHER trigger condition (moving a ship into a system
 *    with a frontier token and no other players' ships) isn't validated —
 *    EXPLORE_FRONTIER just checks the token is there and (now) that the
 *    player owns Dark Energy Tap.
 */

export function explorePlanet(
  state: GameState,
  action: { type: "EXPLORE_PLANET"; playerId: PlayerId; planetId: PlanetId },
  rules: RuleData,
): ActionResult {
  if (state.mode === "base") {
    return { ok: false, error: "RR 35: Exploration is a Prophecy of Kings mechanic, not available in Base-only games." };
  }
  const entry = Object.entries(state.systems).find(([, s]) => s.planets.some((p) => p.planetId === action.planetId));
  if (!entry) return { ok: false, error: `No planet ${action.planetId} on the board.` };
  const [systemId, system] = entry;
  const planet = system.planets.find((p) => p.planetId === action.planetId)!;

  if (planet.controllerId !== action.playerId) {
    return { ok: false, error: `RR 35: this player doesn't control ${action.planetId}.` };
  }
  if (planet.explored) {
    return { ok: false, error: `RR 35: ${action.planetId} has already been explored.` };
  }

  const planetData = rules.planets[action.planetId];
  const trait = planetData?.traits[0] as "cultural" | "industrial" | "hazardous" | undefined;
  if (!trait) {
    return { ok: false, error: `RR 35: ${action.planetId} has no trait and can't be explored.` };
  }

  const deck = state.explorationDecks?.[trait] ?? [];
  let nextState: GameState = state;
  const events: GameEvent[] = [];

  if (deck.length > 0) {
    const [cardId, ...rest] = deck;
    const result = applyExplorationCard(state, action.playerId, systemId as SystemId, action.planetId, cardId, rules);
    nextState = result.state;
    events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: trait });
    nextState = {
      ...nextState,
      explorationDecks: { ...nextState.explorationDecks!, [trait]: rest },
    };
  }

  nextState = setExplored(nextState, systemId as SystemId, action.planetId);
  return { ok: true, state: nextState, events };
}

export function exploreFrontier(
  state: GameState,
  action: { type: "EXPLORE_FRONTIER"; playerId: PlayerId; systemId: SystemId },
  rules: RuleData,
): ActionResult {
  if (state.mode === "base") {
    return { ok: false, error: "RR 35: Frontier tokens are a Prophecy of Kings mechanic, not available in Base-only games." };
  }
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (!system.frontierToken) return { ok: false, error: `RR 35: ${action.systemId} has no frontier token.` };
  if (!state.players[action.playerId]?.technologies.includes(asTechId("dark_energy_tap"))) {
    return { ok: false, error: "RR 35: exploring a frontier token requires owning the Dark Energy Tap technology." };
  }

  const deck = state.explorationDecks?.frontier ?? [];
  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [action.systemId]: { ...system, frontierToken: false } },
  };
  const events: GameEvent[] = [];

  if (deck.length > 0) {
    const [cardId, ...rest] = deck;
    const result = applyExplorationCard(nextState, action.playerId, action.systemId, null, cardId, rules);
    nextState = { ...result.state, explorationDecks: { ...result.state.explorationDecks!, frontier: rest } };
    events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: "frontier" });
  }

  return { ok: true, state: nextState, events };
}

/** Shared mechanical draw resolution — `planetId` is null for frontier draws (no planet to attach to). */
function applyExplorationCard(
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
  if (state.mode === "base") {
    return { ok: false, error: "RR 35.9: Relics are a Prophecy of Kings mechanic, not available in Base-only games." };
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
