import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, ExplorationCardId, asTechId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { GROUND_FORCE_TYPES } from "../types/enums";
import { hasPoKContent } from "../rules/gameMode";
import { fisherYatesShuffle } from "../setup/mapGeneration";
import { maybeQueueSecretObjectiveLimit } from "./agendaEffects";
import { drawActionCard } from "./actionCards";
import { drawActionCardsForPlayer } from "../rules/yssaril";
import { effectiveCommoditiesMax } from "../rules/spaceStations";
import { checkReinforcementsAvailable } from "../rules/reinforcements";
import { applyIconoclastOmegaOmegaDeploy } from "../rules/naalu";
import { placeGenericGammaWormholeToken } from "../rules/wormholeTokens";
import { checkTechPrerequisites, spendForCost } from "./technology";

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
  action: { type: "EXPLORE_FRONTIER"; playerId: PlayerId; systemId: SystemId; choice?: ExplorationCardChoice },
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
    const result = applyExplorationCard(nextState, action.playerId, action.systemId, null, cardId, rules, action.choice);
    nextState = result.state;
    events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: "frontier" });
    const card = rules.explorationCards[cardId];
    const goesToDiscard = !card?.isRelicFragment && !card?.attach && !card?.keepInPlayArea && !card?.purge;
    nextState = {
      ...nextState,
      explorationDecks: { ...nextState.explorationDecks!, frontier: drawResult.deck },
      explorationDiscardPiles: { ...nextState.explorationDiscardPiles, frontier: goesToDiscard ? [...drawResult.discardPile, cardId] : drawResult.discardPile } as GameState["explorationDiscardPiles"],
    };
  }

  return { ok: true, state: nextState, events };
}

/**
 * Player choices for exploration cards that need one — optional on every
 * call, since most cards (relic fragments, plain attachments,
 * unconditional gains) need nothing here at all. Each field is scoped to
 * the 1 specific card(s) it applies to; irrelevant fields for whichever
 * card actually resolved are simply ignored. Exported so every one of
 * this project's own 4 call sites of applyExplorationCard can accept
 * this same shape on their own action types, rather than 4 separate
 * (and inevitably drifting) redefinitions.
 */
export interface ExplorationCardChoice {
  /** entropic_field/keleres_ship/major_entropic_field/minor_entropic_field: which pool(s) the gained command token(s) go to — RR doesn't specify, matching this project's own established pattern (e.g. N'orr Supremacy) of letting the player choose. */
  commandTokenPools?: ("tactic" | "fleet" | "strategy")[];
  /** abandoned_warehouses: "gain 2 commodities" (false/omitted) vs "convert up to 2 of your commodities to trade goods" (true). */
  convertInsteadOfGain?: boolean;
  /** abandoned_warehouses: how many commodities to convert, 0-2, only relevant if convertInsteadOfGain is true. */
  convertCount?: number;
  /** functioning_base/local_fabricators: omitted/false = just gain 1 commodity (the simple, no-cost option); true = spend to trigger the alternate effect instead. */
  spendForAlternateEffect?: boolean;
  /** functioning_base/local_fabricators: which resource to spend for the alternate effect, only relevant if spendForAlternateEffect is true. */
  spendSource?: "trade_good" | "commodity";
  /** merchant_station: "replenish your commodities" (false/omitted) vs "convert your commodities to trade goods" (true, converts ALL of them, unlike abandoned_warehouses' own up-to-2 cap). */
  convertAllInsteadOfReplenish?: boolean;
  /** core_mine/expedition/volatile_fuel_source: only consulted if this player has NO mech on the planet — "you may" remove 1 infantry for the benefit (false/omitted = decline, get nothing). */
  removeInfantryForBenefit?: boolean;
  /** mercenary_outfit: "you may place 1 infantry" — false/omitted = decline. */
  placeInfantry?: boolean;
  /** ion_storm: which side the token starts on — RR: the player's own choice. */
  ionStormFaceUp?: "asteroid_field" | "gravity_rift";
}

/** Shared mechanical draw resolution — `planetId` is null for frontier draws (no planet to attach to). Exported so phases/technologyAbilities.ts's Sling Relay can reuse the exact same draw/apply logic (it triggers an exploration through a different door — a tech ability, not RR 35's normal "gained control" or "frontier token" triggers — but the card draw itself works identically either way). */
export function applyExplorationCard(
  state: GameState,
  playerId: PlayerId,
  systemId: SystemId,
  planetId: PlanetId | null,
  cardId: string,
  rules: RuleData,
  choice?: ExplorationCardChoice,
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
    let updatedPlanet: PlanetState = {
      ...system.planets.find((p) => p.planetId === planetId)!,
      attachmentIds: [...system.planets.find((p) => p.planetId === planetId)!.attachmentIds, cardId],
    };
    let updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) };

    // Cultural "Demilitarized Zone" (exploration card): "Return all
    // structures on this planet to your reinforcements. Then, return all
    // ground forces on this planet to the space area." A ONE-TIME
    // relocation on top of the card's own ongoing ATTACH restriction
    // above (enforced separately by rules/agendaEffects.ts's own
    // isDemilitarizedZone) — structures are DESTROYED (returned to the
    // box), ground forces are only RELOCATED (moved into the same
    // system's own space area, not destroyed).
    if (cardId === "demilitarized_zone_explore") {
      let spaceUnitsByPlayer = updatedSystem.spaceUnitsByPlayer;
      const finalPlanetUnitsByPlayer: PlanetState["unitsByPlayer"] = {};
      for (const [ownerId, stacks] of Object.entries(updatedPlanet.unitsByPlayer)) {
        const groundForceStacks = (stacks ?? []).filter((s) => GROUND_FORCE_TYPES.includes(s.unitType));
        if (groundForceStacks.length > 0) {
          const existingSpaceStacks = spaceUnitsByPlayer[ownerId as PlayerId] ?? [];
          const mergedSpaceStacks = [...existingSpaceStacks];
          for (const gf of groundForceStacks) {
            const existing = mergedSpaceStacks.find((s) => s.unitType === gf.unitType);
            if (existing) existing.count += gf.count;
            else mergedSpaceStacks.push({ ...gf });
          }
          spaceUnitsByPlayer = { ...spaceUnitsByPlayer, [ownerId]: mergedSpaceStacks };
        }
        // Structures (space_dock, pds) are simply dropped here — "returned to reinforcements" needs no further tracking in this project's own model (reinforcements availability is computed dynamically from what's NOT on the board).
      }
      updatedPlanet = { ...updatedPlanet, unitsByPlayer: finalPlanetUnitsByPlayer };
      updatedSystem = { ...updatedSystem, spaceUnitsByPlayer, planets: updatedSystem.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) };
    }

    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: updatedSystem } };
  } else if (card.keepInPlayArea) {
    nextState = {
      ...nextState,
      players: {
        ...nextState.players,
        [playerId]: { ...nextState.players[playerId], explorationCardsInPlayArea: [...nextState.players[playerId].explorationCardsInPlayArea, cardId as never] },
      },
    };
  } else if (cardId === "freelancers") {
    // "You may produce 1 unit in this system; you may spend influence as if it were resources to produce this unit." A one-time, this-system-scoped opportunity — tracked here, consumed by phases/production.ts's own executeProduction (its own freelancersActive flag) whenever the player actually chooses to use it. Confirmed (tirules2.com/C_exploration_cards): "a player cannot place ground forces produced by Freelancers on a planet in the active system that they are yet to gain and explore" — RR's own general "gain, THEN explore, one planet at a time" sequencing already keeps this correct here, since this card only ever resolves for a planet that's already been fully gained.
    nextState = {
      ...nextState,
      players: {
        ...nextState.players,
        [playerId]: { ...nextState.players[playerId], pendingFreelancersGrants: [...(nextState.players[playerId].pendingFreelancersGrants ?? []), systemId] },
      },
    };
  } else if (cardId === "entropic_field" || cardId === "keleres_ship" || cardId === "major_entropic_field" || cardId === "minor_entropic_field") {
    // "Gain N command token(s) [and M trade goods]." Pool choice defaults to strategy if not specified (an arbitrary but harmless default — the caller is expected to actually specify this).
    const tokenCount = cardId === "keleres_ship" ? 2 : 1;
    const tradeGoods = cardId === "major_entropic_field" ? 3 : cardId === "minor_entropic_field" ? 1 : cardId === "entropic_field" ? 2 : 0;
    const pools: ("tactic" | "fleet" | "strategy")[] = choice?.commandTokenPools ?? Array(tokenCount).fill("strategy");
    let updatedPlayer = player;
    for (let i = 0; i < tokenCount; i++) {
      const pool = pools[i] ?? "strategy";
      const { tactic, fleet, strategy, onBoard } = updatedPlayer.commandTokens;
      if (tactic + fleet + strategy + onBoard.length >= 16) break;
      updatedPlayer = { ...updatedPlayer, commandTokens: { ...updatedPlayer.commandTokens, [pool]: updatedPlayer.commandTokens[pool] + 1 } };
    }
    updatedPlayer = { ...updatedPlayer, tradeGoods: updatedPlayer.tradeGoods + tradeGoods };
    nextState = { ...nextState, players: { ...nextState.players, [playerId]: updatedPlayer } };
  } else if (cardId === "derelict_vessel") {
    // "Draw 1 secret objective."
    const deck = nextState.secretObjectiveDeck ?? [];
    if (deck.length > 0) {
      const [objectiveId, ...rest] = deck;
      nextState = {
        ...nextState,
        secretObjectiveDeck: rest,
        players: { ...nextState.players, [playerId]: { ...player, secretObjectives: [...player.secretObjectives, objectiveId] } },
      };
      nextState = maybeQueueSecretObjectiveLimit(nextState, rules, playerId);
    }
  } else if (cardId === "lost_crew") {
    // "Draw 2 Action Cards."
    const drawResult = drawActionCardsForPlayer(nextState, playerId, 2);
    nextState = drawResult.state;
    events.push(...drawResult.events);
  } else if (cardId === "dead_world") {
    // "Draw 1 relic."
    const deck = nextState.relicDeck ?? [];
    if (deck.length > 0) {
      const [relicId, ...rest] = deck;
      nextState = {
        ...nextState,
        relicDeck: rest,
        players: { ...nextState.players, [playerId]: { ...player, relics: [...player.relics, relicId] as never } },
      };
    }
  } else if (cardId === "abandoned_warehouses") {
    // "You may gain 2 commodities, or you may convert up to 2 of your commodities to trade goods."
    if (choice?.convertInsteadOfGain) {
      const amount = Math.max(0, Math.min(2, choice.convertCount ?? 0, player.commodities));
      nextState = { ...nextState, players: { ...nextState.players, [playerId]: { ...player, commodities: player.commodities - amount, tradeGoods: player.tradeGoods + amount } } };
    } else {
      const max = effectiveCommoditiesMax(nextState, playerId, rules.factions[player.factionId]?.commoditiesMax ?? 0);
      nextState = { ...nextState, players: { ...nextState.players, [playerId]: { ...player, commodities: Math.min(max, player.commodities + 2) } } };
    }
  } else if (cardId === "merchant_station") {
    // "You may replenish your commodities, or you may convert your commodities to trade goods." (ALL of them for the convert option, unlike Abandoned Warehouses' own up-to-2 cap.)
    if (choice?.convertAllInsteadOfReplenish) {
      nextState = { ...nextState, players: { ...nextState.players, [playerId]: { ...player, commodities: 0, tradeGoods: player.tradeGoods + player.commodities } } };
    } else {
      const max = effectiveCommoditiesMax(nextState, playerId, rules.factions[player.factionId]?.commoditiesMax ?? 0);
      nextState = { ...nextState, players: { ...nextState.players, [playerId]: { ...player, commodities: max } } };
    }
  } else if (cardId === "functioning_base" || cardId === "local_fabricators") {
    // "You may gain 1 commodity, or you may spend 1 trade good or 1 commodity to [draw 1 action card | place 1 mech from reinforcements on this planet]."
    if (choice?.spendForAlternateEffect) {
      const source = choice.spendSource ?? "trade_good";
      const hasEnough = source === "trade_good" ? player.tradeGoods >= 1 : player.commodities >= 1;
      if (hasEnough) {
        let updatedPlayer: Player = source === "trade_good" ? { ...player, tradeGoods: player.tradeGoods - 1 } : { ...player, commodities: player.commodities - 1 };
        if (cardId === "functioning_base") {
          nextState = { ...nextState, players: { ...nextState.players, [playerId]: updatedPlayer } };
          const drawResult = drawActionCardsForPlayer(nextState, playerId, 1);
          nextState = drawResult.state;
          events.push(...drawResult.events);
          updatedPlayer = nextState.players[playerId];
        } else if (planetId) {
          const reinforcementsCheck = checkReinforcementsAvailable(nextState, playerId, [{ unitType: "mech", count: 1 }]);
          if (reinforcementsCheck.ok) {
            const system = nextState.systems[systemId];
            const targetPlanet = system.planets.find((p) => p.planetId === planetId)!;
            const stacks = targetPlanet.unitsByPlayer[playerId] ?? [];
            const existing = stacks.find((s) => s.unitType === "mech");
            const updatedStacks = existing ? stacks.map((s) => (s.unitType === "mech" ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "mech" as const, count: 1, damagedCount: 0 }];
            const updatedPlanet: PlanetState = { ...targetPlanet, unitsByPlayer: { ...targetPlanet.unitsByPlayer, [playerId]: updatedStacks } };
            nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
          }
        }
        nextState = { ...nextState, players: { ...nextState.players, [playerId]: updatedPlayer } };
      }
    } else {
      const max = effectiveCommoditiesMax(nextState, playerId, rules.factions[player.factionId]?.commoditiesMax ?? 0);
      nextState = { ...nextState, players: { ...nextState.players, [playerId]: { ...player, commodities: Math.min(max, player.commodities + 1) } } };
    }
  } else if ((cardId === "core_mine" || cardId === "expedition" || cardId === "volatile_fuel_source") && planetId) {
    // "If you have at least 1 mech on this planet, or if you remove 1 infantry from this planet, [gain 1 trade good | ready this planet | gain 1 command token]." Confirmed clarification in this project's own data: "if you have at least 1 mech, gain the benefit; otherwise, you MAY choose to remove 1 infantry to gain the benefit" — mech presence is NOT itself consumed/removed, just checked.
    const system = nextState.systems[systemId];
    const targetPlanet = system.planets.find((p) => p.planetId === planetId)!;
    const hasMech = (targetPlanet.unitsByPlayer[playerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0);
    let qualifies = hasMech;
    let updatedPlanet = targetPlanet;
    if (!hasMech && choice?.removeInfantryForBenefit) {
      const stacks = targetPlanet.unitsByPlayer[playerId] ?? [];
      const infantryStack = stacks.find((s) => s.unitType === "infantry" && s.count > 0);
      if (infantryStack) {
        updatedPlanet = { ...targetPlanet, unitsByPlayer: { ...targetPlanet.unitsByPlayer, [playerId]: stacks.map((s) => (s === infantryStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0) } };
        qualifies = true;
      }
    }
    if (qualifies) {
      let updatedPlayer = player;
      if (cardId === "core_mine") updatedPlayer = { ...player, tradeGoods: player.tradeGoods + 1 };
      else if (cardId === "volatile_fuel_source") {
        const { tactic, fleet, strategy, onBoard } = player.commandTokens;
        if (tactic + fleet + strategy + onBoard.length < 16) updatedPlayer = { ...player, commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy + 1 } };
      } else {
        updatedPlanet = { ...updatedPlanet, exhausted: false };
      }
      nextState = {
        ...nextState,
        systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } },
        players: { ...nextState.players, [playerId]: updatedPlayer },
      };
    } else if (updatedPlanet !== targetPlanet) {
      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
    }
  } else if (cardId === "mercenary_outfit" && planetId && choice?.placeInfantry) {
    // "You may place 1 infantry from your reinforcements on this planet."
    const reinforcementsCheck = checkReinforcementsAvailable(nextState, playerId, [{ unitType: "infantry", count: 1 }]);
    if (reinforcementsCheck.ok) {
      const system = nextState.systems[systemId];
      const targetPlanet = system.planets.find((p) => p.planetId === planetId)!;
      const stacks = targetPlanet.unitsByPlayer[playerId] ?? [];
      const existing = stacks.find((s) => s.unitType === "infantry");
      const updatedStacks = existing ? stacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "infantry" as const, count: 1, damagedCount: 0 }];
      const updatedPlanet: PlanetState = { ...targetPlanet, unitsByPlayer: { ...targetPlanet.unitsByPlayer, [playerId]: updatedStacks } };
      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
    }
  } else if (cardId === "gamma_wormhole_explore" || cardId === "gamma_relay") {
    // "Place a gamma wormhole token in this system. Then, purge this card." (the purge itself is handled by every caller's own goesToDiscard check reading card.purge — nothing further needed here.) Uses ONE of the 3 shared generic gamma tokens — see rules/wormholeTokens.ts's own placeGenericGammaWormholeToken.
    const placed = placeGenericGammaWormholeToken(nextState, systemId);
    if (placed.ok) nextState = placed.state;
  } else if (cardId === "ion_storm") {
    // "Place the ion storm token in this system with either side face up. Then, place this card in the common play area. At the end of a 'Move Ships' or 'Retreat' sub-step... during which 1 or more of your ships use the ion storm wormhole, flip the ion storm token to its opposing side."
    // KNOWN SCOPE LIMIT: the token's initial placement (with the chosen face) is tracked here; the "place this card in the COMMON play area" (visible/usable by all players, not just this one) and the flip-on-wormhole-use trigger aren't wired into this project's own movement resolution yet — flagged rather than silently dropped.
    const system = nextState.systems[systemId];
    nextState = {
      ...nextState,
      systems: { ...nextState.systems, [systemId]: { ...system, ionStormFace: choice?.ionStormFaceUp ?? "asteroid_field" } },
    };
  } else if (cardId === "mirage_frontier") {
    // "Place the Mirage planet token in this system. Gain the Mirage planet card and ready it. Then, purge this card." Confirmed via this player's own gained-and-readied control of a brand-new planet entry added to this system.
    const system = nextState.systems[systemId];
    const mirageData = rules.planets["mirage" as PlanetId];
    if (mirageData && !system.planets.some((p) => p.planetId === "mirage")) {
      const mirageplanet: PlanetState = {
        planetId: "mirage" as PlanetId,
        controllerId: playerId,
        exhausted: false,
        explored: true,
        attachmentIds: [],
        unitsByPlayer: {},
      };
      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: [...system.planets, mirageplanet] } } };
    }
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

  // Naalu Collective "Iconoclast ΩΩ" (mech, Deploy): "when another player gains a relic, place 1 mech" — see rules/naalu.ts's own applyIconoclastOmegaOmegaDeploy.
  const stateWithIconoclastDeploy = applyIconoclastOmegaOmegaDeploy({ ...state, relicDeck: rest, players: { ...state.players, [action.playerId]: updatedPlayer } }, action.playerId);

  return {
    ok: true,
    state: stateWithIconoclastDeploy,
    events: [{ type: "RELIC_GAINED", playerId: action.playerId, relicId }],
  };
}

/**
 * Frontier "Enigmatic Device" (exploration card, kept in play area):
 * "ACTION: You may spend 6 resources and purge this card to research 1
 * technology." A standalone component action, separate from resolving
 * the card itself (which just places it face-up, via this file's own
 * applyExplorationCard, using the same generic keepInPlayArea path
 * every OTHER keepInPlayArea card already uses).
 */
export function useEnigmaticDevice(
  state: GameState,
  action: { type: "USE_ENIGMATIC_DEVICE"; playerId: PlayerId; techId: import("../types/ids").TechId; exhaustPlanetIdsForResources: PlanetId[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.explorationCardsInPlayArea.includes("enigmatic_device" as never)) {
    return { ok: false, error: "This player doesn't have Enigmatic Device in their play area." };
  }
  if (state.phase !== "action") return { ok: false, error: "This component action only applies during the action phase." };
  if (state.activePlayerId !== action.playerId) return { ok: false, error: "It isn't this player's turn." };
  if (state.pendingTacticalAction) return { ok: false, error: "Cannot use this with a tactical action in progress." };
  if (player.technologies.includes(action.techId)) return { ok: false, error: `This player already owns ${action.techId}.` };

  const prereqCheck = checkTechPrerequisites(state, action.playerId, action.techId, rules, []);
  if (!prereqCheck.met) return { ok: false, error: `RR 90.7: ${prereqCheck.reason}` };

  const spend = spendForCost(state, action.playerId, 6, action.exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  const spentPlayer = spend.state.players[action.playerId];
  const updatedPlayer: Player = {
    ...spentPlayer,
    technologies: [...spentPlayer.technologies, action.techId],
    explorationCardsInPlayArea: spentPlayer.explorationCardsInPlayArea.filter((id) => id !== ("enigmatic_device" as never)),
  };
  return { ok: true, state: { ...spend.state, players: { ...spend.state.players, [action.playerId]: updatedPlayer } }, events: [] };
}
