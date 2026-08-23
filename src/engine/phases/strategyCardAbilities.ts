import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId, TechId, UnitUpgradeId, ObjectiveId, AgendaId, StrategyCardId, asAbilityId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { hasAbility } from "../rules/abilities";
import { isAdjacent } from "../rules/adjacency";
import { executeProduction } from "./production";
import { researchTechnology, researchUnitUpgrade } from "./technology";
import { scoreObjectiveCore } from "./actionPhase";
import { maybeApplyMinisterOfCommerce, getLawOwner, isLawActiveWithOutcome, isDemilitarizedZone, maybeQueueSecretObjectiveLimit } from "./agendaEffects";
import { drawActionCard } from "./actionCards";
import { drawActionCardsForPlayer } from "../rules/yssaril";
import { checkReinforcementsAvailable, COMMAND_TOKEN_TOTAL_SUPPLY } from "../rules/reinforcements";
import { effectiveCommoditiesMax } from "../rules/spaceStations";
import { getTriadResourcesAndInfluence } from "../rules/relics";

/**
 * RR 20-ish, one section per strategy card (data/strategyCards.json has the
 * exact text this follows). `payload`'s shape is genuinely different per
 * card — this file validates/casts it per `cardId` at runtime rather than
 * encoding all 8 shapes into the Actions.ts union (see that action's own
 * comment: "one payload shape per card").
 *
 * A strategy card's secondary ability normally costs 1 strategy-pool
 * command token (RR 83.a) — every handler below charges it EXCEPT
 * Leadership's (explicitly exempted by the card's own text) and anywhere
 * else noted.
 *
 * NOT implemented / simplified, flagged rather than silently wrong:
 *  - No validation that the acting player actually holds this strategy
 *    card this round, or that it hasn't already been used — strategyPhase.ts
 *    tracks card assignment but "used this round" tracking isn't wired to
 *    these handlers yet.
 *  - Command token "reinforcement supply" limits aren't tracked anywhere
 *    (Leadership/Diplomacy/Warfare all nominally draw from a finite
 *    physical supply) — tokens are just added/removed from the pools
 *    directly.
 *  - Technology research doesn't validate prerequisites (see
 *    phases/technology.ts's own note).
 */

function chargeSecondaryToken(player: Player): { ok: true; player: Player } | { ok: false; error: string } {
  if (player.commandTokens.strategy < 1) return { ok: false, error: "Not enough strategy tokens (need 1) to use this secondary ability." };
  return { ok: true, player: { ...player, commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 } } };
}

function exhaustPlanetsForInfluence(
  state: GameState,
  playerId: PlayerId,
  planetIds: PlanetId[],
  rules: RuleData,
): { ok: true; state: GameState; influence: number } | { ok: false; error: string } {
  let influence = 0;
  let next = state;
  for (const planetId of planetIds) {
    // RR "The Triad" (relic): same "spent as if it were a planet card" sentinel-id special-case as phases/technology.ts's own spendForCost.
    if (planetId === ("the_triad" as never)) {
      const triadPlayer = next.players[playerId];
      if (!triadPlayer.relics.includes("the_triad" as never)) return { ok: false, error: "This player doesn't own The Triad." };
      if ((triadPlayer.exhaustedRelics ?? []).includes("the_triad" as never)) return { ok: false, error: "The Triad is already exhausted." };
      influence += getTriadResourcesAndInfluence(triadPlayer).influence;
      next = { ...next, players: { ...next.players, [playerId]: { ...triadPlayer, exhaustedRelics: [...(triadPlayer.exhaustedRelics ?? []), "the_triad" as never] } } };
      continue;
    }
    const entry = Object.entries(next.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    const planet = entry?.[1].planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const data = rules.planets[planetId];
    if (!data) return { ok: false, error: `No static data for ${planetId}.` };
    influence += data.influence;
    const [systemId, system] = entry!;
    next = {
      ...next,
      systems: {
        ...next.systems,
        [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)) },
      },
    };
  }
  return { ok: true, state: next, influence };
}

function readyPlanets(state: GameState, playerId: PlayerId, planetIds: PlanetId[]): GameState {
  let next = state;
  for (const planetId of planetIds) {
    // RR "The Triad" (relic): "can be readied... as if it were a planet card" — confirmed by planet-readying effects like Diplomacy's own secondary here. Same sentinel-id special-case as phases/technology.ts's own spendForCost.
    if (planetId === ("the_triad" as never)) {
      const triadPlayer = next.players[playerId];
      if (triadPlayer && (triadPlayer.exhaustedRelics ?? []).includes("the_triad" as never)) {
        next = { ...next, players: { ...next.players, [playerId]: { ...triadPlayer, exhaustedRelics: (triadPlayer.exhaustedRelics ?? []).filter((r) => r !== ("the_triad" as never)) } } };
      }
      continue;
    }
    const entry = Object.entries(next.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    if (!entry) continue;
    const [systemId, system] = entry;
    const planet = system.planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== playerId) continue;
    next = {
      ...next,
      systems: {
        ...next.systems,
        [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: false } : p)) },
      },
    };
  }
  return next;
}

function tokensConserved(distribution: { tactic: number; fleet: number; strategy: number }, expectedTotal: number): boolean {
  return distribution.tactic + distribution.fleet + distribution.strategy === expectedTotal && Object.values(distribution).every((v) => v >= 0);
}

// --- entry points ------------------------------------------------------------

export function resolveStrategyPrimary(
  state: GameState,
  action: { type: "RESOLVE_STRATEGY_PRIMARY"; playerId: PlayerId; cardId: string; payload: unknown },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  // RR 83.3/83.7: a player may only resolve the PRIMARY ability of a
  // strategy card THEY OWN, and only once (it's exhausted right after —
  // see the end of this function). Previously unchecked entirely: any
  // player could resolve any card's primary, any number of times.
  const ownCardEntry = player.strategyCards.find((c) => c.cardId === action.cardId);
  if (!ownCardEntry) return { ok: false, error: `RR 83.3: this player doesn't hold the "${action.cardId}" strategy card.` };
  if (ownCardEntry.exhausted) return { ok: false, error: `RR 82.2/71.6: the "${action.cardId}" strategy card has already been used this round.` };
  const p = (action.payload ?? {}) as Record<string, unknown>;
  const result = resolveStrategyPrimaryEffect(state, action, player, p, rules);
  if (!result.ok) return result;

  // RR 82.2/71.6: exhaust the card right after its primary resolves.
  const resolvingPlayer = result.state.players[action.playerId];
  const nextState: GameState = {
    ...result.state,
    players: {
      ...result.state.players,
      [action.playerId]: { ...resolvingPlayer, strategyCards: resolvingPlayer.strategyCards.map((c) => (c.cardId === action.cardId ? { ...c, exhausted: true } : c)) },
    },
  };
  return { ok: true, state: nextState, events: result.events };
}

/** The actual per-card primary-ability effects — split out from resolveStrategyPrimary so that function's own ownership/exhaustion bookkeeping (RR 83.3/82.2) wraps every card's effect in exactly one place, instead of being duplicated in every `case` branch. */
export function resolveStrategyPrimaryEffect(
  state: GameState,
  action: { type: "RESOLVE_STRATEGY_PRIMARY"; playerId: PlayerId; cardId: string; payload: unknown },
  player: Player,
  p: Record<string, unknown>,
  rules: RuleData,
): ActionResult {
  switch (action.cardId) {
    case "leadership": {
      const dist = p.tokenDistribution as { tactic: number; fleet: number; strategy: number };
      const spendIds = (p.exhaustPlanetIdsForInfluence as PlanetId[]) ?? [];
      const spent = exhaustPlanetsForInfluence(state, action.playerId, spendIds, rules);
      if (!spent.ok) return spent;
      const bonusTokens = Math.floor(spent.influence / 3);
      if (!tokensConserved(dist, 3 + bonusTokens)) {
        return { ok: false, error: `RR: distribution must total exactly ${3 + bonusTokens} tokens (3 base + ${bonusTokens} from influence).` };
      }
      return applyTokenGain(spent.state, action.playerId, dist);
    }

    case "diplomacy": {
      const targetSystemId = p.targetSystemId as SystemId;
      const readyIds = ((p.readyPlanetIds as PlanetId[]) ?? []).slice(0, 2);
      const mecatol = Object.entries(state.systems).find(([, s]) => s.planets.some((pl) => rules.planets[pl.planetId]?.isMecatolRex))?.[0];
      if (targetSystemId === mecatol) return { ok: false, error: "RR: can't choose the Mecatol Rex system." };
      const targetSystem = state.systems[targetSystemId];
      if (!targetSystem || !targetSystem.planets.some((pl) => pl.controllerId === action.playerId)) {
        return { ok: false, error: "RR: chosen system must contain a planet this player controls." };
      }
      let next = state;
      for (const otherId of Object.keys(state.players)) {
        if (otherId === action.playerId || state.players[otherId as PlayerId].eliminated) continue;
        const other = next.players[otherId as PlayerId];
        if (!other.commandTokens.onBoard.includes(targetSystemId)) {
          next = {
            ...next,
            players: { ...next.players, [otherId]: { ...other, commandTokens: { ...other.commandTokens, onBoard: [...other.commandTokens.onBoard, targetSystemId] } } },
          };
        }
      }
      next = readyPlanets(next, action.playerId, readyIds);
      return { ok: true, state: next, events: [] };
    }

    case "politics": {
      const newSpeakerId = p.newSpeakerId as PlayerId;
      if (!state.players[newSpeakerId] || state.players[newSpeakerId].eliminated) return { ok: false, error: "Invalid new speaker." };
      let next: GameState = {
        ...state,
        players: Object.fromEntries(
          Object.entries(state.players).map(([id, pl]) => [id, { ...pl, isSpeaker: id === newSpeakerId }]),
        ) as GameState["players"],
      };
      // RR 2.9/23.5: reshuffles the discard pile into a fresh deck if it's
      // ever drawn from while empty — same shared helper every other draw
      // site in this project uses. Previously this manually sliced
      // `actionCardDeck` directly, silently drawing nothing once it ran out
      // instead of reshuffling.
      const drawResult = drawActionCardsForPlayer(next, action.playerId, 2);
      next = drawResult.state;
      const reorder = p.order as { agendaId: import("../types/ids").AgendaId; placement: "top" | "bottom" }[] | undefined;
      if (reorder && reorder.length > 0) {
        const deckIds = next.agendaDeck.deckIds.filter((id) => !reorder.some((r) => r.agendaId === id));
        const toTop = reorder.filter((r) => r.placement === "top").map((r) => r.agendaId);
        const toBottom = reorder.filter((r) => r.placement === "bottom").map((r) => r.agendaId);
        next = { ...next, agendaDeck: { ...next.agendaDeck, deckIds: [...toTop, ...deckIds, ...toBottom] } };
      }
      return { ok: true, state: next, events: drawResult.events };
    }

    case "construction": {
      const placements = (p.placements as { planetId?: PlanetId; systemId?: SystemId; unitType: "space_dock" | "pds" }[]).slice(0, 2);
      const spaceDockCount = placements.filter((pl) => pl.unitType === "space_dock").length;
      if (spaceDockCount > 1) return { ok: false, error: "RR: at most 1 Space Dock may be placed this way." };
      return placeStructuresFree(state, action.playerId, placements, rules);
    }

    case "trade": {
      const chosenIds = (p.chosenPlayerIds as PlayerId[]) ?? [];
      const factionId = player.factionId;
      const max = effectiveCommoditiesMax(state, action.playerId, rules.factions[factionId]?.commoditiesMax ?? 0);
      let next: GameState = {
        ...state,
        players: {
          ...state.players,
          [action.playerId]: { ...player, tradeGoods: player.tradeGoods + 3, commodities: max },
        },
      };
      next = maybeApplyMinisterOfCommerce(next, rules, action.playerId);
      for (const otherId of chosenIds) {
        const other = next.players[otherId];
        if (!other || other.eliminated) continue;
        const otherMax = effectiveCommoditiesMax(next, otherId, rules.factions[other.factionId]?.commoditiesMax ?? 0);
        next = { ...next, players: { ...next.players, [otherId]: { ...other, commodities: otherMax } } };
        next = maybeApplyMinisterOfCommerce(next, rules, otherId);
        // RR 92.4b: a player chosen this way can only use the secondary
        // once, and specifically cannot ALSO use the normal (paid-in-
        // strategy-token) secondary afterward this same round — mark them
        // as already having used it here, same tracking
        // resolveStrategySecondary itself checks. Previously unmarked,
        // meaning a chosen player could still pay to use the secondary
        // again for a second replenish.
        const tradeCardId = "trade" as StrategyCardId;
        next = { ...next, strategyCardSecondariesUsedBy: { ...next.strategyCardSecondariesUsedBy, [tradeCardId]: [...(next.strategyCardSecondariesUsedBy?.[tradeCardId] ?? []), otherId] } };
      }
      return { ok: true, state: next, events: [] };
    }

    case "warfare": {
      const removeFromSystemId = p.removeFromSystemId as SystemId;
      const dist = p.redistribution as { tactic: number; fleet: number; strategy: number };
      if (!player.commandTokens.onBoard.includes(removeFromSystemId)) {
        return { ok: false, error: `This player has no command token in ${removeFromSystemId}.` };
      }
      const currentTotal = player.commandTokens.tactic + player.commandTokens.fleet + player.commandTokens.strategy;
      if (!tokensConserved(dist, currentTotal + 1)) {
        return { ok: false, error: `RR: redistribution must total exactly ${currentTotal + 1} tokens (current ${currentTotal} + 1 gained).` };
      }
      // RR "Fleet Regulations" ("for"): see applyTokenGain's own note on why this needed checking here too.
      if (dist.fleet > 4 && isLawActiveWithOutcome(state, "fleet_regulations" as AgendaId, "for")) {
        return { ok: false, error: 'RR "Fleet Regulations": a player\'s fleet pool cannot exceed 4 command tokens while this law is active.' };
      }
      const updatedPlayer: Player = {
        ...player,
        commandTokens: { tactic: dist.tactic, fleet: dist.fleet, strategy: dist.strategy, onBoard: player.commandTokens.onBoard.filter((id) => id !== removeFromSystemId) },
      };
      return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
    }

    case "technology": {
      const freeTechId = p.freeTechId as TechId;
      const paidTechId = p.paidTechId as TechId | undefined;
      const paidSpendIds = (p.exhaustPlanetIdsForPaid as PlanetId[]) ?? [];
      const free = researchTechnology(state, action.playerId, freeTechId, 0, [], rules);
      if (!free.ok) return free;
      if (!paidTechId) return free;
      // RR "Minister of Sciences": the owner doesn't need to spend resources when resolving Technology's primary/secondary — the SECOND research this ability grants is free for them, same as the first always is for everyone.
      const ministerOfSciencesOwnerId = getLawOwner(free.state, "minister_of_sciences" as AgendaId);
      const paidCost = ministerOfSciencesOwnerId === action.playerId ? 0 : 6;
      return researchTechnology(free.state, action.playerId, paidTechId, paidCost, paidSpendIds, rules);
    }

    case "imperial": {
      const scoreObjectiveId = p.scoreObjectiveId as ObjectiveId | undefined;
      let next = state;
      const events: GameEvent[] = [];
      if (scoreObjectiveId) {
        const scored = scoreObjectiveCore(next, action.playerId, scoreObjectiveId, (p.scoreSpend as never) ?? undefined, rules);
        if (!scored.ok) return scored;
        next = scored.state;
        events.push(...scored.events);
      }
      const mecatol = Object.entries(next.systems).find(([, s]) => s.planets.some((pl) => rules.planets[pl.planetId]?.isMecatolRex));
      const controlsMecatol = mecatol?.[1].planets.some((pl) => rules.planets[pl.planetId]?.isMecatolRex && pl.controllerId === action.playerId) ?? false;
      if (controlsMecatol) {
        const pl = next.players[action.playerId];
        next = { ...next, players: { ...next.players, [action.playerId]: { ...pl, victoryPoints: { ...pl.victoryPoints, current: pl.victoryPoints.current + 1 } } } };
      } else {
        const deck = next.secretObjectiveDeck;
        if (deck && deck.length > 0) {
          const [objectiveId, ...rest] = deck;
          const pl = next.players[action.playerId];
          next = { ...next, secretObjectiveDeck: rest, players: { ...next.players, [action.playerId]: { ...pl, secretObjectives: [...pl.secretObjectives, objectiveId] } } };
          next = maybeQueueSecretObjectiveLimit(next, rules, action.playerId);
        }
      }
      return { ok: true, state: next, events };
    }

    default:
      return { ok: false, error: `Unknown strategy card "${action.cardId}".` };
  }
}

export function resolveStrategySecondary(
  state: GameState,
  action: { type: "RESOLVE_STRATEGY_SECONDARY"; playerId: PlayerId; cardId: string; payload: unknown },
  rules: RuleData,
  /** RR "Galactic Crisis Pact": the elected strategy card's secondary is free (no strategy-token cost) for every player this one time — see phases/directiveEffects.ts's useGalacticCrisisPact. Also bypasses the normal "someone else chose this card this round" eligibility below entirely, since Galactic Crisis Pact's own card is agenda-elected, not necessarily chosen by anyone this round at all. */
  skipCost?: boolean,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };

  if (!skipCost) {
    // RR 83.4: a player may only resolve the SECONDARY ability of a
    // strategy card CHOSEN BY ANOTHER PLAYER — never their own — and
    // only once per card per round (RR 82.1's own "may resolve" framing,
    // tracked here since nothing previously did). Previously unchecked
    // entirely: a player could resolve their OWN card's secondary, or
    // the same other player's card's secondary repeatedly.
    if (player.strategyCards.some((c) => c.cardId === action.cardId)) {
      return { ok: false, error: `RR 83.4: this player owns the "${action.cardId}" strategy card themselves — only OTHER players may resolve its secondary ability.` };
    }
    const chosenByAnyone = Object.values(state.players).some((p) => p.strategyCards.some((c) => c.cardId === action.cardId));
    if (!chosenByAnyone) {
      return { ok: false, error: `RR 83.4: no player has chosen the "${action.cardId}" strategy card this round.` };
    }
    if ((state.strategyCardSecondariesUsedBy?.[action.cardId as StrategyCardId] ?? []).includes(action.playerId)) {
      return { ok: false, error: `RR 82.1: this player has already resolved the "${action.cardId}" strategy card's secondary ability this round.` };
    }
  }

  const p = (action.payload ?? {}) as Record<string, unknown>;
  const result = resolveStrategySecondaryEffect(state, action, player, p, rules, skipCost);
  if (!result.ok) return result;
  if (skipCost) return result;

  const cardId = action.cardId as StrategyCardId;
  const nextState: GameState = {
    ...result.state,
    strategyCardSecondariesUsedBy: { ...result.state.strategyCardSecondariesUsedBy, [cardId]: [...(result.state.strategyCardSecondariesUsedBy?.[cardId] ?? []), action.playerId] },
  };
  return { ok: true, state: nextState, events: result.events };
}

/** The actual per-card secondary-ability effects — split out from resolveStrategySecondary so that function's own eligibility/once-per-round bookkeeping (RR 83.4/82.1) wraps every card's effect in exactly one place. */
export function resolveStrategySecondaryEffect(
  state: GameState,
  action: { type: "RESOLVE_STRATEGY_SECONDARY"; playerId: PlayerId; cardId: string; payload: unknown },
  player: Player,
  p: Record<string, unknown>,
  rules: RuleData,
  skipCost?: boolean,
): ActionResult {
  // Leadership's secondary is the one explicit exception to the "costs 1 strategy token" rule.
  // Hacan "MASTERS OF TRADE" (faction ability, passive): "You do not have to spend a command token to resolve the secondary ability of the 'Trade' strategy card." A second, similarly-scoped exception — only for "trade" specifically, only for a player who actually has this ability.
  let charged = player;
  if (action.cardId !== "leadership" && !skipCost && !(action.cardId === "trade" && hasAbility(player, asAbilityId("masters_of_trade")))) {
    const charge = chargeSecondaryToken(player);
    if (!charge.ok) return charge;
    charged = charge.player;
  }
  let working: GameState = { ...state, players: { ...state.players, [action.playerId]: charged } };

  switch (action.cardId) {
    case "leadership": {
      const dist = p.tokenDistribution as { tactic: number; fleet: number; strategy: number };
      const spendIds = (p.exhaustPlanetIdsForInfluence as PlanetId[]) ?? [];
      const spent = exhaustPlanetsForInfluence(working, action.playerId, spendIds, rules);
      if (!spent.ok) return spent;
      const bonusTokens = Math.floor(spent.influence / 3);
      if (!tokensConserved(dist, bonusTokens)) return { ok: false, error: `RR: distribution must total exactly ${bonusTokens} tokens.` };
      return applyTokenGain(spent.state, action.playerId, dist);
    }
    case "diplomacy": {
      const readyIds = ((p.readyPlanetIds as PlanetId[]) ?? []).slice(0, 2);
      return { ok: true, state: readyPlanets(working, action.playerId, readyIds), events: [] };
    }
    case "politics": {
      // RR 2.9/23.5: same reshuffle-on-empty fix as the primary above —
      // previously this manually sliced `actionCardDeck` directly.
      let next = working;
      const drawResult = drawActionCardsForPlayer(next, action.playerId, 2);
      next = drawResult.state;
      return { ok: true, state: next, events: drawResult.events };
    }
    case "construction": {
      const placement = p.placement as { planetId?: PlanetId; systemId?: SystemId; unitType: "space_dock" | "pds" };
      // RR 24.3: unlike every other secondary's generic "just spend 1
      // strategy token" cost, this token specifically gets PLACED on the
      // board in the target system (unless the player already has one
      // there, in which case it's simply returned to reinforcements —
      // i.e. exactly what the generic charge above already did).
      // Previously the token was always just spent with no placement at
      // all, regardless of this card's own distinct text.
      // Clan of Saar "Floating Factory": placement.systemId is already
      // the target system directly (no planet to look up through) — see
      // placeStructuresFree's own Saar branch below.
      let targetSystemId: SystemId;
      if (placement.unitType === "space_dock" && charged.factionId === ("saar" as never)) {
        if (!placement.systemId) return { ok: false, error: "Floating Factory placement needs a target system." };
        targetSystemId = placement.systemId;
      } else {
        const entry = Object.entries(working.systems).find(([, s]) => s.planets.some((pl) => pl.planetId === placement.planetId));
        if (!entry) return { ok: false, error: `No planet ${placement.planetId} on the board.` };
        targetSystemId = entry[0] as SystemId;
      }
      let withToken = working;
      if (!charged.commandTokens.onBoard.includes(targetSystemId)) {
        withToken = { ...working, players: { ...working.players, [action.playerId]: { ...charged, commandTokens: { ...charged.commandTokens, onBoard: [...charged.commandTokens.onBoard, targetSystemId] } } } };
      }
      return placeStructuresFree(withToken, action.playerId, [placement], rules);
    }
    case "trade": {
      const max = effectiveCommoditiesMax(working, action.playerId, rules.factions[charged.factionId]?.commoditiesMax ?? 0);
      const next: GameState = { ...working, players: { ...working.players, [action.playerId]: { ...charged, commodities: max } } };
      return { ok: true, state: maybeApplyMinisterOfCommerce(next, rules, action.playerId), events: [] };
    }
    case "warfare": {
      const systemId = p.systemId as SystemId;
      const planetId = p.planetId as PlanetId;
      const units = p.units as { unitType: import("../types/enums").UnitType; count: number }[];
      const exhaustPlanetIdsForResources = p.exhaustPlanetIdsForResources as PlanetId[] | undefined;
      // RR 99.3: this secondary is specifically restricted to a space dock
      // in the player's OWN home system — not any system they happen to
      // control a producer in. Previously unchecked entirely.
      if (systemId !== rules.homeSystemByFaction[charged.factionId]) {
        return { ok: false, error: "RR 99.3: this secondary can only resolve the Production ability of a space dock in this player's own home system." };
      }
      const enemyShipsPresent = Object.entries(working.systems[systemId]?.spaceUnitsByPlayer ?? {}).some(
        ([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0),
      );
      if (enemyShipsPresent) return { ok: false, error: "RR: that system contains another player's ships." };
      return executeProduction(working, action.playerId, systemId, planetId, units, rules, undefined, true, undefined, exhaustPlanetIdsForResources);
    }
    case "technology": {
      // Jol-Nar "BRILLIANT" (faction ability, passive): "When you spend a command token to resolve the secondary ability of the 'Technology' strategy card, you may resolve the primary ability instead." Same free-tech + optional-paid-2nd-tech shape as the primary handler above, just triggered from the secondary's own payload/cost context.
      if (hasAbility(player, asAbilityId("brilliant")) && p.useBrilliant) {
        const freeTechId = p.techId as TechId;
        const paidTechId = p.brilliantPaidTechId as TechId | undefined;
        const paidSpendIds = (p.brilliantExhaustPlanetIdsForPaid as PlanetId[]) ?? [];
        const free = researchTechnology(working, action.playerId, freeTechId, 0, [], rules);
        if (!free.ok) return free;
        if (!paidTechId) return free;
        const ministerOfSciencesOwnerId = getLawOwner(free.state, "minister_of_sciences" as AgendaId);
        const paidCost = ministerOfSciencesOwnerId === action.playerId ? 0 : 6;
        return researchTechnology(free.state, action.playerId, paidTechId, paidCost, paidSpendIds, rules);
      }
      const techId = p.techId as TechId;
      const spendIds = (p.exhaustPlanetIds as PlanetId[]) ?? [];
      // RR "Minister of Sciences": see the primary handler's own note — same free-research treatment for the owner here.
      const ministerOfSciencesOwnerId = getLawOwner(working, "minister_of_sciences" as AgendaId);
      const cost = ministerOfSciencesOwnerId === action.playerId ? 0 : 4;
      return researchTechnology(working, action.playerId, techId, cost, spendIds, rules);
    }
    case "imperial": {
      const deck = working.secretObjectiveDeck;
      if (!deck || deck.length === 0) return { ok: true, state: working, events: [] };
      const [objectiveId, ...rest] = deck;
      const pl = working.players[action.playerId];
      const withSecret: GameState = { ...working, secretObjectiveDeck: rest, players: { ...working.players, [action.playerId]: { ...pl, secretObjectives: [...pl.secretObjectives, objectiveId] } } };
      return {
        ok: true,
        state: maybeQueueSecretObjectiveLimit(withSecret, rules, action.playerId),
        events: [],
      };
    }
    default:
      return { ok: false, error: `Unknown strategy card "${action.cardId}".` };
  }
}

// --- shared helpers ----------------------------------------------------------

function applyTokenGain(state: GameState, playerId: PlayerId, dist: { tactic: number; fleet: number; strategy: number }): ActionResult {
  // RR "Fleet Regulations" ("for"): confirmed, this cap applies to EVERY
  // way a player's own fleet pool could change, not just Predictive
  // Intelligence's own equivalent redistribution — Leadership's primary/
  // secondary (this function) and Warfare's own primary (see its own
  // case below) previously didn't check it at all.
  if (dist.fleet > 4 && isLawActiveWithOutcome(state, "fleet_regulations" as AgendaId, "for")) {
    return { ok: false, error: 'RR "Fleet Regulations": a player\'s fleet pool cannot exceed 4 command tokens while this law is active.' };
  }
  const player = state.players[playerId];
  // RR/the wiki's own Reinforcements page: 16 command tokens total per player, covering every pool AND every on-board token at once — see rules/reinforcements.ts's own doc comments.
  const newTotal = dist.tactic + dist.fleet + dist.strategy + player.commandTokens.onBoard.length;
  if (newTotal > COMMAND_TOKEN_TOTAL_SUPPLY) {
    return { ok: false, error: `RR: this player only has ${COMMAND_TOKEN_TOTAL_SUPPLY} command tokens total (including any already on the board) — this distribution would need ${newTotal}.` };
  }
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [playerId]: { ...player, commandTokens: { ...player.commandTokens, tactic: dist.tactic, fleet: dist.fleet, strategy: dist.strategy } } } },
    events: [],
  };
}

function placeStructuresFree(
  state: GameState,
  playerId: PlayerId,
  placements: { planetId?: PlanetId; systemId?: SystemId; unitType: "space_dock" | "pds" }[],
  rules: RuleData,
): ActionResult {
  let next = state;
  const placingPlayer = next.players[playerId];
  for (const placement of placements) {
    const { unitType } = placement;
    // Clan of Saar "Floating Factory" (Space Placement): "This unit is
    // placed in the space area of a system instead of on a planet."
    // Confirmed (twilight-imperium.fandom.com/wiki/The_Clan_of_Saar,
    // scottmk.github.io/ti4-reference): genuinely a SYSTEM-level target,
    // not a specific planet — a different placement flow entirely from
    // every other structure below, which stays exactly as it was.
    if (unitType === "space_dock" && placingPlayer.factionId === ("saar" as never)) {
      const result = placeFloatingFactory(next, playerId, placement.systemId, rules);
      if (!result.ok) return result;
      next = result.state;
      continue;
    }

    const planetId = placement.planetId!;
    const entry = Object.entries(next.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    if (!entry) return { ok: false, error: `No planet ${planetId} on the board.` };
    const [systemId, system] = entry;
    const planet = system.planets.find((p) => p.planetId === planetId)!;
    if (planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    // TE SPACE STATIONS (rulebook p.10): "structures and ground forces cannot be placed on or committed to space stations."
    if (planet.isSpaceStation) return { ok: false, error: "TE SPACE STATIONS: no structures can be placed on a space station." };

    // RR 85.4/85.5: at most 1 space dock and 2 PDS per planet, counting
    // ALL players' units there together — same limit (and the same RR
    // "Homeland Defense Act" PDS-lift exception) as PRODUCE_UNITS'
    // own check; previously this — Construction's own way of placing
    // structures — didn't check it at all.
    const pdsLimitLifted = isLawActiveWithOutcome(next, "homeland_defense_act" as AgendaId, "for");
    const limit = unitType === "pds" ? 2 : 1;
    if (!(unitType === "pds" && pdsLimitLifted)) {
      const existingOnPlanet = Object.values(planet.unitsByPlayer)
        .flat()
        .filter((s): s is NonNullable<typeof s> => Boolean(s) && s!.unitType === unitType)
        .reduce((sum, s) => sum + s!.count, 0);
      if (existingOnPlanet + 1 > limit) {
        return { ok: false, error: `RR 85: ${planetId} can have at most ${limit} ${unitType}(s); it already has ${existingOnPlanet}.` };
      }
    }
    const reinforcementsCheck = checkReinforcementsAvailable(next, playerId, [{ unitType, count: 1 }]);
    if (!reinforcementsCheck.ok) return reinforcementsCheck;

    const stacks = (planet.unitsByPlayer[playerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === unitType);
    if (existing) existing.count += 1;
    else stacks.push({ unitType, count: 1, damagedCount: 0 });

    const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: stacks } };
    const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) };
    next = { ...next, systems: { ...next.systems, [systemId]: updatedSystem } };
  }
  return { ok: true, state: next, events: [] };
}

/**
 * Clan of Saar "Floating Factory" placement: a system-level target (the
 * player must control at least 1 planet there — the natural system-level
 * analog of Construction's normal "a planet you control" targeting, since
 * this unit is never actually ON a planet), 1 per system (its own analog
 * of the normal "1 space dock per planet" limit), placed directly into
 * spaceUnitsByPlayer instead of any planet's unitsByPlayer. Once placed
 * here, movement (phases/tacticalAction.ts's own moveShips), Space Cannon
 * targeting, and fleet-pool counting all already work correctly with NO
 * further special-casing needed — every one of those is already
 * data-driven off getUnitStats()/STRUCTURE_TYPES rather than a hardcoded
 * SHIP_TYPES membership check, and Floating Factory's own faction-
 * override stats (move: 1/2, no combat value) already flow through
 * generically once the unit actually exists in the right place.
 */
function placeFloatingFactory(state: GameState, playerId: PlayerId, systemId: SystemId | undefined, rules: RuleData): ActionResult {
  if (!systemId) return { ok: false, error: "Floating Factory placement needs a target system." };
  const system = state.systems[systemId];
  if (!system) return { ok: false, error: `Unknown system ${systemId}.` };
  const controlledPlanets = system.planets.filter((p) => p.controllerId === playerId);
  if (controlledPlanets.length === 0) {
    return { ok: false, error: `This player doesn't control any planet in ${systemId}.` };
  }
  // Confirmed (yjmrobert.com/tirules/factions/f_saar): "The Saar player
  // cannot place a Floating Factory in a system if the only planet they
  // control in that system has the Demilitarized Zone cultural
  // exploration card attached." — only blocks if EVERY controlled planet
  // there is a Demilitarized Zone (matching "the ONLY planet"); if they
  // control a second, non-DMZ planet in the same system, placement is
  // still legal.
  if (controlledPlanets.every((p) => isDemilitarizedZone(p))) {
    return { ok: false, error: 'RR "Demilitarized Zone": cannot place a Floating Factory here — every planet this player controls in this system is a Demilitarized Zone.' };
  }
  const existingCount = (system.spaceUnitsByPlayer[playerId] ?? []).filter((s) => s.unitType === "space_dock").reduce((sum, s) => sum + s.count, 0);
  if (existingCount >= 1) {
    return { ok: false, error: `This player already has a Floating Factory in ${systemId} (at most 1 per system).` };
  }
  const reinforcementsCheck = checkReinforcementsAvailable(state, playerId, [{ unitType: "space_dock", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const stacks = (system.spaceUnitsByPlayer[playerId] ?? []).map((s) => ({ ...s }));
  const existing = stacks.find((s) => s.unitType === "space_dock");
  if (existing) existing.count += 1;
  else stacks.push({ unitType: "space_dock", count: 1, damagedCount: 0 });

  void rules;
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [playerId]: stacks } };
  return { ok: true, state: { ...state, systems: { ...state.systems, [systemId]: updatedSystem } }, events: [] };
}

type TechIdOrActionCard = string;
