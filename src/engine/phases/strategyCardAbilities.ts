import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId, TechId, UnitUpgradeId, ObjectiveId, AgendaId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { isAdjacent } from "../rules/adjacency";
import { executeProduction } from "./production";
import { researchTechnology, researchUnitUpgrade } from "./technology";
import { scoreObjectiveCore } from "./actionPhase";
import { maybeApplyMinisterOfCommerce, getLawOwner } from "./agendaEffects";

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
  const p = (action.payload ?? {}) as Record<string, unknown>;

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
      const drawn: TechIdOrActionCard[] = [];
      for (let i = 0; i < 2; i++) {
        const deck = next.actionCardDeck;
        if (!deck || deck.length === 0) break;
        const [cardId, ...rest] = deck;
        next = { ...next, actionCardDeck: rest, players: { ...next.players, [action.playerId]: { ...next.players[action.playerId], actionCards: [...next.players[action.playerId].actionCards, cardId] } } };
      }
      const reorder = p.order as { agendaId: import("../types/ids").AgendaId; placement: "top" | "bottom" }[] | undefined;
      if (reorder && reorder.length > 0) {
        const deckIds = next.agendaDeck.deckIds.filter((id) => !reorder.some((r) => r.agendaId === id));
        const toTop = reorder.filter((r) => r.placement === "top").map((r) => r.agendaId);
        const toBottom = reorder.filter((r) => r.placement === "bottom").map((r) => r.agendaId);
        next = { ...next, agendaDeck: { ...next.agendaDeck, deckIds: [...toTop, ...deckIds, ...toBottom] } };
      }
      return { ok: true, state: next, events: [] };
    }

    case "construction": {
      const placements = (p.placements as { planetId: PlanetId; unitType: "space_dock" | "pds" }[]).slice(0, 2);
      const spaceDockCount = placements.filter((pl) => pl.unitType === "space_dock").length;
      if (spaceDockCount > 1) return { ok: false, error: "RR: at most 1 Space Dock may be placed this way." };
      return placeStructuresFree(state, action.playerId, placements);
    }

    case "trade": {
      const chosenIds = (p.chosenPlayerIds as PlayerId[]) ?? [];
      const factionId = player.factionId;
      const max = rules.factions[factionId]?.commoditiesMax ?? 0;
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
        const otherMax = rules.factions[other.factionId]?.commoditiesMax ?? 0;
        next = { ...next, players: { ...next.players, [otherId]: { ...other, commodities: otherMax } } };
        next = maybeApplyMinisterOfCommerce(next, rules, otherId);
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
  /** RR "Galactic Crisis Pact": the elected strategy card's secondary is free (no strategy-token cost) for every player this one time — see phases/directiveEffects.ts's useGalacticCrisisPact. */
  skipCost?: boolean,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  const p = (action.payload ?? {}) as Record<string, unknown>;

  // Leadership's secondary is the one explicit exception to the "costs 1 strategy token" rule.
  let charged = player;
  if (action.cardId !== "leadership" && !skipCost) {
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
      const deck = working.actionCardDeck;
      if (!deck || deck.length === 0) return { ok: true, state: working, events: [] };
      const [cardId, ...rest] = deck.length >= 2 ? deck : [deck[0]];
      const drawn = deck.slice(0, Math.min(2, deck.length));
      const nextDeck = deck.slice(drawn.length);
      const pl = working.players[action.playerId];
      return {
        ok: true,
        state: { ...working, actionCardDeck: nextDeck, players: { ...working.players, [action.playerId]: { ...pl, actionCards: [...pl.actionCards, ...drawn] } } },
        events: [],
      };
    }
    case "construction": {
      const placement = p.placement as { planetId: PlanetId; unitType: "space_dock" | "pds" };
      return placeStructuresFree(working, action.playerId, [placement]);
    }
    case "trade": {
      const max = rules.factions[charged.factionId]?.commoditiesMax ?? 0;
      const next: GameState = { ...working, players: { ...working.players, [action.playerId]: { ...charged, commodities: max } } };
      return { ok: true, state: maybeApplyMinisterOfCommerce(next, rules, action.playerId), events: [] };
    }
    case "warfare": {
      const systemId = p.systemId as SystemId;
      const planetId = p.planetId as PlanetId;
      const units = p.units as { unitType: import("../types/enums").UnitType; count: number }[];
      const enemyShipsPresent = Object.entries(working.systems[systemId]?.spaceUnitsByPlayer ?? {}).some(
        ([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0),
      );
      if (enemyShipsPresent) return { ok: false, error: "RR: that system contains another player's ships." };
      return executeProduction(working, action.playerId, systemId, planetId, units, rules);
    }
    case "technology": {
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
      return {
        ok: true,
        state: { ...working, secretObjectiveDeck: rest, players: { ...working.players, [action.playerId]: { ...pl, secretObjectives: [...pl.secretObjectives, objectiveId] } } },
        events: [],
      };
    }
    default:
      return { ok: false, error: `Unknown strategy card "${action.cardId}".` };
  }
}

// --- shared helpers ----------------------------------------------------------

function applyTokenGain(state: GameState, playerId: PlayerId, dist: { tactic: number; fleet: number; strategy: number }): ActionResult {
  const player = state.players[playerId];
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [playerId]: { ...player, commandTokens: { ...player.commandTokens, tactic: dist.tactic, fleet: dist.fleet, strategy: dist.strategy } } } },
    events: [],
  };
}

function placeStructuresFree(
  state: GameState,
  playerId: PlayerId,
  placements: { planetId: PlanetId; unitType: "space_dock" | "pds" }[],
): ActionResult {
  let next = state;
  for (const { planetId, unitType } of placements) {
    const entry = Object.entries(next.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    if (!entry) return { ok: false, error: `No planet ${planetId} on the board.` };
    const [systemId, system] = entry;
    const planet = system.planets.find((p) => p.planetId === planetId)!;
    if (planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };

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

type TechIdOrActionCard = string;
