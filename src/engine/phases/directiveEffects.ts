import { GameState, Player, PlanetState, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, AgendaId, TechId, UnitUpgradeId, StrategyCardId } from "../types/ids";
import { GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { getAdjacentSystems } from "../rules/adjacency";
import { researchTechnology } from "./technology";
import { resolveStrategySecondary } from "./strategyCardAbilities";

/**
 * RR 7 DIRECTIVES — the actual per-directive mechanics, mirroring
 * phases/agendaEffects.ts's own split (that file is laws; this one is
 * directives — a directive never becomes an ongoing law, it always
 * resolves once and is discarded, so none of these check
 * isLawActiveWithOutcome the way agendaEffects.ts's laws do). Same
 * incremental, one-section-per-card approach as that file.
 *
 * This dispatcher (applyDirectiveResolutionSideEffects) is ONLY for
 * directives whose entire effect is fully automatic once the winner is
 * known — no further player choice needed. Directives that DO need a real
 * choice (which technology, which player, whether to opt into an optional
 * research, etc.) get their own dedicated pending-state + action instead —
 * see this file's own exported handlers further down for those.
 */
export function applyDirectiveResolutionSideEffects(
  state: GameState,
  rules: RuleData,
  agendaId: AgendaId,
  winner: string | null,
  votesByOutcome: Record<string, { playerId: PlayerId; votes: number }[]>,
): GameState {
  let nextState = state;

  // RR "Archived Secret": elected player draws 1 secret objective.
  if (agendaId === "archived_secret" && winner) {
    const electedId = winner as PlayerId;
    const elected = nextState.players[electedId];
    if (elected) {
      const deck = nextState.secretObjectiveDeck ?? [];
      const drawn = deck.slice(0, 1);
      nextState = {
        ...nextState,
        secretObjectiveDeck: deck.slice(drawn.length),
        players: { ...nextState.players, [electedId]: { ...elected, secretObjectives: [...elected.secretObjectives, ...drawn] } },
      };
    }
  }

  // RR "Arms Reduction" ("for"): each player destroys down to at most 2 dreadnoughts and 4 cruisers. ("against" is queued for the next strategy phase — see phases/actionPhase.ts's startNewRound.)
  if (agendaId === "arms_reduction" && winner === "for") {
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      let updatedSpace = system.spaceUnitsByPlayer;
      let changed = false;
      for (const [pid, stacks] of Object.entries(system.spaceUnitsByPlayer)) {
        const updatedStacks = (stacks ?? []).map((s) => {
          if (s.unitType === "dreadnought" && s.count > 2) {
            changed = true;
            return { ...s, count: 2, damagedCount: Math.min(s.damagedCount, 2) };
          }
          if (s.unitType === "cruiser" && s.count > 4) {
            changed = true;
            return { ...s, count: 4, damagedCount: Math.min(s.damagedCount, 4) };
          }
          return s;
        });
        if (changed) updatedSpace = { ...updatedSpace, [pid]: updatedStacks };
      }
      if (changed) nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, spaceUnitsByPlayer: updatedSpace } } };
    }
  }

  // RR "Compensated Disarmament": destroy each ground force on the elected planet; the controller gains 1 trade good per unit destroyed.
  if (agendaId === "compensated_disarmament" && winner) {
    const planetId = winner as PlanetId;
    const entry = Object.entries(nextState.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    if (entry) {
      const [systemId, system] = entry;
      const planet = system.planets.find((p) => p.planetId === planetId)!;
      let destroyedCount = 0;
      const updatedUnitsByPlayer: PlanetState["unitsByPlayer"] = {};
      for (const [pid, stacks] of Object.entries(planet.unitsByPlayer)) {
        const groundStacks = (stacks ?? []).filter((s) => GROUND_FORCE_TYPES.includes(s.unitType));
        destroyedCount += groundStacks.reduce((sum, s) => sum + s.count, 0);
        updatedUnitsByPlayer[pid as PlayerId] = (stacks ?? []).filter((s) => !GROUND_FORCE_TYPES.includes(s.unitType));
      }
      const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: updatedUnitsByPlayer };
      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
      if (planet.controllerId && destroyedCount > 0) {
        const controller = nextState.players[planet.controllerId];
        if (controller) {
          nextState = { ...nextState, players: { ...nextState.players, [planet.controllerId]: { ...controller, tradeGoods: controller.tradeGoods + destroyedCount } } };
        }
      }
    }
  }

  // RR "Economic Equality": everyone's trade goods reset to 0 ("against"), or reset then set to 5 ("for").
  if (agendaId === "economic_equality" && (winner === "for" || winner === "against")) {
    const setTo = winner === "for" ? 5 : 0;
    for (const p of Object.values(nextState.players)) {
      nextState = { ...nextState, players: { ...nextState.players, [p.id]: { ...p, tradeGoods: setTo } } };
    }
  }

  // RR "Incentive Program": reveal 1 public objective from the matching stage.
  if (agendaId === "incentive_program" && (winner === "for" || winner === "against")) {
    const deck = nextState.publicObjectiveDeck;
    if (deck) {
      if (winner === "for" && deck.stageI.length > 0) {
        const [objectiveId, ...rest] = deck.stageI;
        nextState = { ...nextState, objectives: [...nextState.objectives, { kind: "publicI", objectiveId, revealed: true }], publicObjectiveDeck: { ...deck, stageI: rest } };
      } else if (winner === "against" && deck.stageII.length > 0) {
        const [objectiveId, ...rest] = deck.stageII;
        nextState = { ...nextState, objectives: [...nextState.objectives, { kind: "publicII", objectiveId, revealed: true }], publicObjectiveDeck: { ...deck, stageII: rest } };
      }
    }
  }

  // RR "Mutiny": every "for" voter gains ("for" won) or loses ("against" won) 1 VP.
  if (agendaId === "mutiny" && (winner === "for" || winner === "against")) {
    for (const voter of votesByOutcome["for"] ?? []) {
      const p = nextState.players[voter.playerId];
      if (!p) continue;
      const delta = winner === "for" ? 1 : -1;
      nextState = { ...nextState, players: { ...nextState.players, [voter.playerId]: { ...p, victoryPoints: { ...p.victoryPoints, current: Math.max(0, p.victoryPoints.current + delta) } } } };
    }
  }

  // RR "Seed of an Empire": the player with the most ("for") or fewest ("against") VP gains 1 VP. Ties: takes the first found — RR doesn't specify a tiebreaker for this card, flagged rather than guessed.
  if (agendaId === "seed_of_an_empire" && (winner === "for" || winner === "against")) {
    const candidates = Object.values(nextState.players).filter((p) => !p.eliminated);
    if (candidates.length > 0) {
      const target =
        winner === "for"
          ? candidates.reduce((best, p) => (p.victoryPoints.current > best.victoryPoints.current ? p : best))
          : candidates.reduce((best, p) => (p.victoryPoints.current < best.victoryPoints.current ? p : best));
      nextState = { ...nextState, players: { ...nextState.players, [target.id]: { ...target, victoryPoints: { ...target.victoryPoints, current: target.victoryPoints.current + 1 } } } };
    }
  }

  // RR "Swords to Plowshares": "for" halves (rounded up) every player's infantry on each controlled planet, granting trade goods per unit destroyed; "against" adds 1 infantry to each controlled planet instead.
  if (agendaId === "swords_to_plowshares" && (winner === "for" || winner === "against")) {
    const tradeGoodsGained: Partial<Record<PlayerId, number>> = {};
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      let updatedPlanets = system.planets;
      let changed = false;
      updatedPlanets = system.planets.map((planet) => {
        if (!planet.controllerId) return planet;
        const stacks = planet.unitsByPlayer[planet.controllerId] ?? [];
        const infantryStack = stacks.find((s) => s.unitType === "infantry");
        if (winner === "for") {
          if (!infantryStack || infantryStack.count <= 0) return planet;
          const destroyCount = Math.ceil(infantryStack.count / 2);
          tradeGoodsGained[planet.controllerId] = (tradeGoodsGained[planet.controllerId] ?? 0) + destroyCount;
          changed = true;
          const updatedStacks = stacks
            .map((s) => (s.unitType === "infantry" ? { ...s, count: s.count - destroyCount, damagedCount: Math.min(s.damagedCount, s.count - destroyCount) } : s))
            .filter((s) => s.count > 0);
          return { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [planet.controllerId]: updatedStacks } };
        }
        changed = true;
        const existing = stacks.find((s) => s.unitType === "infantry" && !s.upgradeId);
        const updatedStacks = existing
          ? stacks.map((s) => (s === existing ? { ...s, count: s.count + 1 } : s))
          : [...stacks, { unitType: "infantry" as const, count: 1, damagedCount: 0 }];
        return { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [planet.controllerId]: updatedStacks } };
      });
      if (changed) nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: updatedPlanets } } };
    }
    for (const [pid, amount] of Object.entries(tradeGoodsGained)) {
      const p = nextState.players[pid as PlayerId];
      if (p && amount) nextState = { ...nextState, players: { ...nextState.players, [pid]: { ...p, tradeGoods: p.tradeGoods + amount } } };
    }
  }

  // RR "Unconventional Measures": "for" voters draw 2 action cards; "against" voters discard their whole hand. (Each outcome only affects the voters who chose THAT outcome — not "for" voters in both branches, despite the card's own text using "For" in both outcome descriptions; this matches the confirmed real card text, "each player that voted for this outcome".)
  if (agendaId === "unconventional_measures" && (winner === "for" || winner === "against")) {
    const relevantVoters = votesByOutcome[winner] ?? [];
    let actionCardDeck = nextState.actionCardDeck ? [...nextState.actionCardDeck] : [];
    const actionCardDiscardPile = nextState.actionCardDiscardPile ? [...nextState.actionCardDiscardPile] : [];
    for (const voter of relevantVoters) {
      const p = nextState.players[voter.playerId];
      if (!p) continue;
      if (winner === "for") {
        const drawn = actionCardDeck.slice(0, 2);
        actionCardDeck = actionCardDeck.slice(drawn.length);
        nextState = { ...nextState, players: { ...nextState.players, [voter.playerId]: { ...p, actionCards: [...p.actionCards, ...drawn] } } };
      } else {
        nextState = { ...nextState, players: { ...nextState.players, [voter.playerId]: { ...p, actionCards: [] } } };
      }
    }
    nextState = { ...nextState, actionCardDeck, actionCardDiscardPile };
  }

  // RR "Wormhole Research" ("against"): each "against" voter returns 1 command token from their command sheet (any pool — this player's own choice of which; auto-picks tactic first, then fleet, then strategy, as a flagged simplification, same pattern as this project's other minor "which pool" defaults).
  if (agendaId === "wormhole_research" && winner === "against") {
    for (const voter of votesByOutcome["against"] ?? []) {
      const p = nextState.players[voter.playerId];
      if (!p) continue;
      nextState = { ...nextState, players: { ...nextState.players, [voter.playerId]: { ...p, commandTokens: removeOneCommandToken(p.commandTokens) } } };
    }
  }

  // RR "Armed Forces Standardization": sets the elected player's 3 pools to exactly 3/3/2 (tactic/fleet/strategy).
  if (agendaId === "armed_forces_standardization" && winner) {
    const electedId = winner as PlayerId;
    const elected = nextState.players[electedId];
    if (elected) {
      nextState = { ...nextState, players: { ...nextState.players, [electedId]: { ...elected, commandTokens: { ...elected.commandTokens, tactic: 3, fleet: 3, strategy: 2 } } } };
    }
  }

  // RR "Clandestine Operations": "for" removes 2 tokens (any pools), "against" removes 1 specifically from the fleet pool.
  if (agendaId === "clandestine_operations" && (winner === "for" || winner === "against")) {
    for (const p of Object.values(nextState.players)) {
      const updatedTokens =
        winner === "for" ? removeOneCommandToken(removeOneCommandToken(p.commandTokens)) : { ...p.commandTokens, fleet: Math.max(0, p.commandTokens.fleet - 1) };
      nextState = { ...nextState, players: { ...nextState.players, [p.id]: { ...p, commandTokens: updatedTokens } } };
    }
  }

  // RR "Minister of Antiques": elected player gains 1 relic.
  if (agendaId === "minister_of_antiques" && winner) {
    const electedId = winner as PlayerId;
    const elected = nextState.players[electedId];
    const deck = nextState.relicDeck ?? [];
    if (elected && deck.length > 0) {
      const [relicId, ...rest] = deck;
      nextState = { ...nextState, relicDeck: rest, players: { ...nextState.players, [electedId]: { ...elected, relics: [...elected.relics, relicId] } } };
    }
  }

  // RR "Rearmament Agreement": "for" places 1 mech on a controlled planet in each player's own home system (the first one found there, if more than one — RR doesn't specify a pick among several, flagged); "against" replaces every mech everywhere with 1 infantry each.
  if (agendaId === "rearmament_agreement" && (winner === "for" || winner === "against")) {
    if (winner === "for") {
      for (const p of Object.values(nextState.players)) {
        const homeSystemId = rules.homeSystemByFaction[p.factionId] as SystemId | undefined;
        const homeSystem = homeSystemId ? nextState.systems[homeSystemId] : undefined;
        const targetPlanet = homeSystem?.planets.find((pl) => pl.controllerId === p.id);
        if (!homeSystemId || !homeSystem || !targetPlanet) continue;
        const stacks = targetPlanet.unitsByPlayer[p.id] ?? [];
        const existing = stacks.find((s) => s.unitType === "mech" && !s.upgradeId);
        const updatedStacks = existing ? stacks.map((s) => (s === existing ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "mech" as const, count: 1, damagedCount: 0 }];
        const updatedPlanet: PlanetState = { ...targetPlanet, unitsByPlayer: { ...targetPlanet.unitsByPlayer, [p.id]: updatedStacks } };
        nextState = { ...nextState, systems: { ...nextState.systems, [homeSystemId]: { ...homeSystem, planets: homeSystem.planets.map((pl) => (pl.planetId === targetPlanet.planetId ? updatedPlanet : pl)) } } };
      }
    } else {
      for (const [systemId, system] of Object.entries(nextState.systems)) {
        let changed = false;
        const updatedPlanets = system.planets.map((planet) => {
          const updatedUnitsByPlayer: PlanetState["unitsByPlayer"] = {};
          for (const [pid, stacks] of Object.entries(planet.unitsByPlayer)) {
            const mechStack = (stacks ?? []).find((s) => s.unitType === "mech");
            if (mechStack && mechStack.count > 0) {
              changed = true;
              const withoutMechs = (stacks ?? []).filter((s) => s.unitType !== "mech");
              const infantryStack = withoutMechs.find((s) => s.unitType === "infantry" && !s.upgradeId);
              const updatedStacks = infantryStack
                ? withoutMechs.map((s) => (s === infantryStack ? { ...s, count: s.count + mechStack.count } : s))
                : [...withoutMechs, { unitType: "infantry" as const, count: mechStack.count, damagedCount: 0 }];
              updatedUnitsByPlayer[pid as PlayerId] = updatedStacks;
            } else {
              updatedUnitsByPlayer[pid as PlayerId] = stacks;
            }
          }
          return changed ? { ...planet, unitsByPlayer: updatedUnitsByPlayer } : planet;
        });
        if (changed) nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: updatedPlanets } } };
      }
    }
  }

  // RR "Judicial Abolishment": discards the elected law from play outright — no vote-outcome branching, the elected candidate IS the law to remove.
  if (agendaId === "judicial_abolishment" && winner) {
    const electedLawId = winner as AgendaId;
    nextState = {
      ...nextState,
      agendaDeck: {
        ...nextState.agendaDeck,
        lawsInPlay: nextState.agendaDeck.lawsInPlay.filter((l) => l.agendaId !== electedLawId),
        discardIds: [...nextState.agendaDeck.discardIds, electedLawId],
      },
    };
  }

  // RR "Public Execution": elected player discards their whole hand, passes
  // the speaker token to the player on their left if they hold it (RR
  // 8.2.ii's own "left of the speaker" direction — same rotation sense as
  // voting order), and is barred from voting for the rest of THIS agenda
  // phase (enforced in revealAgenda's own voting-order construction).
  if (agendaId === "public_execution" && winner) {
    const electedId = winner as PlayerId;
    const elected = nextState.players[electedId];
    if (elected) {
      let updatedPlayers: GameState["players"] = { ...nextState.players, [electedId]: { ...elected, actionCards: [] } };
      if (elected.isSpeaker) {
        const idx = nextState.seatOrder.indexOf(electedId);
        const leftId = nextState.seatOrder[(idx + 1) % nextState.seatOrder.length];
        if (leftId && leftId !== electedId) {
          updatedPlayers = {
            ...updatedPlayers,
            [electedId]: { ...updatedPlayers[electedId], isSpeaker: false },
            [leftId]: { ...updatedPlayers[leftId], isSpeaker: true },
          };
        }
      }
      nextState = { ...nextState, players: updatedPlayers, agendaPhaseBannedFromVoting: [...(nextState.agendaPhaseBannedFromVoting ?? []), electedId] };
    }
  }

  // RR "Colonial Redistribution": destroy every unit (any player's) on the
  // elected planet — control itself is untouched (destroying units isn't
  // military conquest; whoever controlled it keeps controlling it, same
  // as this project's other "destroy units, don't touch control" agenda
  // effects). If there's a controller, queue their own choice of which
  // fewest-VP player gets the infantry offer — if there's exactly ONE
  // player with the fewest VP, that choice is trivial (no real decision),
  // so this goes straight to queuing THAT player's own infantry-placement
  // offer instead of making the controller pick from a 1-candidate list.
  if (agendaId === "colonial_redistribution" && winner) {
    const planetId = winner as PlanetId;
    const entry = Object.entries(nextState.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    if (entry) {
      const [systemId, system] = entry;
      const planet = system.planets.find((p) => p.planetId === planetId)!;
      const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: {} };
      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };

      if (planet.controllerId) {
        const candidates = Object.values(nextState.players).filter((p) => !p.eliminated);
        if (candidates.length > 0) {
          const minVp = Math.min(...candidates.map((p) => p.victoryPoints.current));
          const lowestVpIds = candidates.filter((p) => p.victoryPoints.current === minVp).map((p) => p.id);
          if (lowestVpIds.length === 1) {
            nextState = { ...nextState, pendingColonialRedistributionInfantryOffer: { planetId, playerId: lowestVpIds[0] } };
          } else {
            nextState = { ...nextState, pendingColonialRedistributionChoice: { planetId, controllerId: planet.controllerId, candidateIds: lowestVpIds } };
          }
        }
      }
    }
  }

  // RR "Research Grant Reallocation": queues the elected player's own
  // choice of which technology to gain — see useResearchGrantReallocation
  // below for the actual grant + fleet-pool cost.
  if (agendaId === "research_grant_reallocation" && winner) {
    nextState = { ...nextState, pendingResearchGrantReallocationChoice: winner as PlayerId };
  }

  // RR "Ixthian Artifact" ("for"): queues the speaker's own die roll — see
  // useIxthianArtifactDieRoll below for the actual 6-10/1-5 branch.
  // ("against" is "No effect" — nothing to do.)
  if (agendaId === "ixthian_artifact" && winner === "for") {
    nextState = { ...nextState, pendingIxthianArtifactDieRoll: true };
  }

  // RR "Wormhole Research" ("for"): determine eligible players (1+ ships
  // in ANY wormhole system, any type) BEFORE the destruction below, since
  // a player with ships only in a gamma-wormhole system stays eligible for
  // the research offer even though nothing of theirs gets destroyed.
  // Confirmed: destruction only ever hits alpha/beta systems specifically,
  // never gamma.
  if (agendaId === "wormhole_research" && winner === "for") {
    const eligiblePlayerIds = new Set<PlayerId>();
    for (const system of Object.values(nextState.systems)) {
      if (system.wormholes.length === 0) continue;
      for (const [pid, stacks] of Object.entries(system.spaceUnitsByPlayer)) {
        if ((stacks ?? []).some((s) => s.count > 0)) eligiblePlayerIds.add(pid as PlayerId);
      }
    }
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      if (!system.wormholes.some((w) => w === "alpha" || w === "beta")) continue;
      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, spaceUnitsByPlayer: {} } } };
    }
    if (eligiblePlayerIds.size > 0) {
      nextState = { ...nextState, pendingWormholeResearchOffer: Array.from(eligiblePlayerIds) };
    }
  }

  // RR "Galactic Crisis Pact": queues every non-eliminated player's own
  // optional, free (no strategy-token cost) chance to use the elected
  // strategy card's secondary ability — see useGalacticCrisisPact below.
  if (agendaId === "galactic_crisis_pact" && winner) {
    const playersRemaining = Object.values(nextState.players).filter((p) => !p.eliminated).map((p) => p.id);
    if (playersRemaining.length > 0) {
      nextState = { ...nextState, pendingGalacticCrisisPactOffer: { cardId: winner as StrategyCardId, playersRemaining } };
    }
  }

  return nextState;
}

/** Shared "return 1 command token from any pool" default for directives that don't specify which — tactic first, then fleet, then strategy. Flagged simplification: real play lets the player choose. */
function removeOneCommandToken(tokens: Player["commandTokens"]): Player["commandTokens"] {
  if (tokens.tactic > 0) return { ...tokens, tactic: tokens.tactic - 1 };
  if (tokens.fleet > 0) return { ...tokens, fleet: tokens.fleet - 1 };
  if (tokens.strategy > 0) return { ...tokens, strategy: tokens.strategy - 1 };
  return tokens;
}

/** RR "Colonial Redistribution": the controller's own choice of which tied fewest-VP player gets the infantry offer. */
export function useColonialRedistributionChoice(
  state: GameState,
  action: { type: "USE_COLONIAL_REDISTRIBUTION_CHOICE"; playerId: PlayerId; chosenPlayerId: PlayerId },
): ActionResult {
  const pending = state.pendingColonialRedistributionChoice;
  if (!pending || pending.controllerId !== action.playerId) {
    return { ok: false, error: "This player has no pending Colonial Redistribution choice right now." };
  }
  if (!pending.candidateIds.includes(action.chosenPlayerId)) {
    return { ok: false, error: "That player isn't one of the tied fewest-VP candidates." };
  }
  const nextState: GameState = {
    ...state,
    pendingColonialRedistributionChoice: undefined,
    pendingColonialRedistributionInfantryOffer: { planetId: pending.planetId, playerId: action.chosenPlayerId },
  };
  return { ok: true, state: nextState, events: [] };
}

/** RR "Colonial Redistribution": the chosen player's own optional choice — place 1 infantry (from reinforcements) on the elected planet. */
export function placeColonialRedistributionInfantry(
  state: GameState,
  action: { type: "PLACE_COLONIAL_REDISTRIBUTION_INFANTRY"; playerId: PlayerId },
): ActionResult {
  const pending = state.pendingColonialRedistributionInfantryOffer;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "This player has no pending Colonial Redistribution infantry offer right now." };
  }
  const entry = Object.entries(state.systems).find(([, s]) => s.planets.some((p) => p.planetId === pending.planetId));
  if (!entry) return { ok: false, error: `No planet ${pending.planetId}.` };
  const [systemId, system] = entry;
  const planet = system.planets.find((p) => p.planetId === pending.planetId)!;

  const stacks = planet.unitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "infantry" && !s.upgradeId);
  const updatedStacks = existing ? stacks.map((s) => (s === existing ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "infantry" as const, count: 1, damagedCount: 0 }];
  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: updatedStacks } };

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === pending.planetId ? updatedPlanet : p)) } },
    pendingColonialRedistributionInfantryOffer: undefined,
  };
  return {
    ok: true,
    state: nextState,
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: systemId as SystemId, planetId: pending.planetId, unitType: "infantry", count: 1, totalCost: 0 }],
  };
}

/** RR "Colonial Redistribution": the chosen player declines the infantry offer. */
export function skipColonialRedistributionInfantry(
  state: GameState,
  action: { type: "SKIP_COLONIAL_REDISTRIBUTION_INFANTRY"; playerId: PlayerId },
): ActionResult {
  const pending = state.pendingColonialRedistributionInfantryOffer;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "This player has no pending Colonial Redistribution infantry offer right now." };
  }
  return { ok: true, state: { ...state, pendingColonialRedistributionInfantryOffer: undefined }, events: [] };
}

/** RR "Research Grant Reallocation": the elected player's own choice of which technology to gain — bypasses RR 90.7 prerequisites entirely (a free grant, not a normal research action), then removes 1 fleet-pool token per prerequisite that technology has (own color-count list length, generic tech OR unit upgrade either one). */
export function useResearchGrantReallocation(
  state: GameState,
  action: { type: "USE_RESEARCH_GRANT_REALLOCATION"; playerId: PlayerId; techId: TechId },
  rules: RuleData,
): ActionResult {
  const pendingPlayerId = state.pendingResearchGrantReallocationChoice;
  if (!pendingPlayerId || pendingPlayerId !== action.playerId) {
    return { ok: false, error: "This player has no pending Research Grant Reallocation choice right now." };
  }
  const player = state.players[action.playerId];
  if (player.technologies.includes(action.techId)) {
    return { ok: false, error: `This player already owns ${action.techId}.` };
  }
  const prerequisiteCount = rules.technologies[action.techId]?.prerequisites.length ?? rules.unitUpgradeTechData[action.techId as unknown as UnitUpgradeId]?.prerequisites.length;
  if (prerequisiteCount === undefined) return { ok: false, error: `No rule data for ${action.techId}.` };

  const updatedPlayer: Player = {
    ...player,
    technologies: [...player.technologies, action.techId],
    commandTokens: { ...player.commandTokens, fleet: Math.max(0, player.commandTokens.fleet - prerequisiteCount) },
  };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    pendingResearchGrantReallocationChoice: undefined,
  };
  return { ok: true, state: nextState, events: [] };
}

/**
 * RR "Ixthian Artifact" ("for"): the speaker's own die roll (pre-rolled by
 * the trusted context, same convention as combat dice elsewhere in this
 * project — see rules/combat.ts's own RNG note). 6-10 opens the "may
 * research 2 technologies" offer for every non-eliminated player; 1-5
 * destroys everything in Mecatol Rex's system, then 3 units per player
 * with any units in each ADJACENT system (own choice of which isn't
 * offered as a separate pending decision here; auto-picks a deterministic
 * 3, flagged as a simplification, same category as this file's other
 * "which pool/unit" defaults).
 */
export function useIxthianArtifactDieRoll(
  state: GameState,
  action: { type: "USE_IXTHIAN_ARTIFACT_DIE_ROLL"; playerId: PlayerId; roll: number },
  rules: RuleData,
): ActionResult {
  if (!state.pendingIxthianArtifactDieRoll) {
    return { ok: false, error: "No Ixthian Artifact die roll is currently pending." };
  }
  const speakerId = state.seatOrder.find((id) => state.players[id]?.isSpeaker);
  if (speakerId !== action.playerId) return { ok: false, error: "Only the speaker rolls for Ixthian Artifact." };
  if (action.roll < 1 || action.roll > 10) return { ok: false, error: "Die roll must be between 1 and 10." };

  let nextState: GameState = { ...state, pendingIxthianArtifactDieRoll: undefined };

  if (action.roll >= 6) {
    const research: Partial<Record<PlayerId, number>> = {};
    for (const p of Object.values(nextState.players)) {
      if (!p.eliminated) research[p.id] = 2;
    }
    nextState = { ...nextState, pendingIxthianArtifactResearch: research };
    return { ok: true, state: nextState, events: [] };
  }

  const mecatolSystemId = rules.mecatolSystemId as SystemId;
  const mecatolSystem = nextState.systems[mecatolSystemId];
  if (mecatolSystem) {
    nextState = {
      ...nextState,
      systems: {
        ...nextState.systems,
        [mecatolSystemId]: { ...mecatolSystem, spaceUnitsByPlayer: {}, planets: mecatolSystem.planets.map((p) => ({ ...p, unitsByPlayer: {} })) },
      },
    };
  }

  const adjacentIds = mecatolSystem ? getAdjacentSystems(nextState, mecatolSystemId) : [];
  for (const adjId of adjacentIds) {
    const system = nextState.systems[adjId];
    if (!system) continue;
    const updatedSpace: SystemState["spaceUnitsByPlayer"] = { ...system.spaceUnitsByPlayer };
    for (const [pid, stacks] of Object.entries(system.spaceUnitsByPlayer)) {
      updatedSpace[pid as PlayerId] = destroyUpToNUnits(stacks ?? [], 3);
    }
    nextState = { ...nextState, systems: { ...nextState.systems, [adjId]: { ...system, spaceUnitsByPlayer: updatedSpace } } };
  }

  return { ok: true, state: nextState, events: [] };
}

/** Destroys up to `n` units from these stacks (ships or ground forces, whichever is passed), in stack order — a deterministic pick, flagged simplification for cases where the real rule leaves the choice to the affected player. */
function destroyUpToNUnits(stacks: UnitStack[], n: number): UnitStack[] {
  let remaining = n;
  const updated = stacks.map((s) => ({ ...s }));
  for (const stack of updated) {
    if (remaining <= 0) break;
    const removed = Math.min(remaining, stack.count);
    stack.count -= removed;
    stack.damagedCount = Math.min(stack.damagedCount, stack.count);
    remaining -= removed;
  }
  return updated.filter((s) => s.count > 0);
}

/** RR "Ixthian Artifact" (die roll 6-10): the player's own choice of which of their remaining allowed technologies to research — free (no resource cost), same as this card's own text (no cost specified). */
export function useIxthianArtifactResearch(
  state: GameState,
  action: { type: "USE_IXTHIAN_ARTIFACT_RESEARCH"; playerId: PlayerId; techId: TechId },
  rules: RuleData,
): ActionResult {
  const remaining = state.pendingIxthianArtifactResearch?.[action.playerId] ?? 0;
  if (remaining <= 0) return { ok: false, error: "This player has no remaining Ixthian Artifact research offers." };

  const result = researchTechnology(state, action.playerId, action.techId, 0, [], rules);
  if (!result.ok) return result;

  const updatedRemaining = { ...state.pendingIxthianArtifactResearch, [action.playerId]: remaining - 1 };
  const nextState: GameState = { ...result.state, pendingIxthianArtifactResearch: updatedRemaining };
  return { ok: true, state: nextState, events: result.events };
}

/** RR "Ixthian Artifact": the player declines any remaining research offers. */
export function skipIxthianArtifactResearch(state: GameState, action: { type: "SKIP_IXTHIAN_ARTIFACT_RESEARCH"; playerId: PlayerId }): ActionResult {
  if (!(state.pendingIxthianArtifactResearch?.[action.playerId] ?? 0)) {
    return { ok: false, error: "This player has no remaining Ixthian Artifact research offers." };
  }
  const updated = { ...state.pendingIxthianArtifactResearch };
  delete updated[action.playerId];
  return { ok: true, state: { ...state, pendingIxthianArtifactResearch: updated }, events: [] };
}

/** RR "Wormhole Research" ("for"): the player's own choice of whether to use their 1 free research offer. */
export function useWormholeResearch(
  state: GameState,
  action: { type: "USE_WORMHOLE_RESEARCH"; playerId: PlayerId; techId: TechId },
  rules: RuleData,
): ActionResult {
  if (!(state.pendingWormholeResearchOffer ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Wormhole Research offer right now." };
  }
  const result = researchTechnology(state, action.playerId, action.techId, 0, [], rules);
  if (!result.ok) return result;
  const nextState: GameState = { ...result.state, pendingWormholeResearchOffer: (state.pendingWormholeResearchOffer ?? []).filter((id) => id !== action.playerId) };
  return { ok: true, state: nextState, events: result.events };
}

/** RR "Wormhole Research": the player declines their free research offer. */
export function skipWormholeResearch(state: GameState, action: { type: "SKIP_WORMHOLE_RESEARCH"; playerId: PlayerId }): ActionResult {
  if (!(state.pendingWormholeResearchOffer ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Wormhole Research offer right now." };
  }
  return { ok: true, state: { ...state, pendingWormholeResearchOffer: (state.pendingWormholeResearchOffer ?? []).filter((id) => id !== action.playerId) }, events: [] };
}

/** RR "Galactic Crisis Pact": the player's own choice of whether to use the elected strategy card's secondary ability, for free (no strategy-token cost, tokens the ability itself places come from reinforcements — i.e. simply not charged against this player's own pools, same net effect). */
export function useGalacticCrisisPact(
  state: GameState,
  action: { type: "USE_GALACTIC_CRISIS_PACT"; playerId: PlayerId; payload: unknown },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingGalacticCrisisPactOffer;
  if (!pending || !pending.playersRemaining.includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Galactic Crisis Pact offer right now." };
  }
  const result = resolveStrategySecondary(state, { type: "RESOLVE_STRATEGY_SECONDARY", playerId: action.playerId, cardId: pending.cardId, payload: action.payload }, rules, true);
  if (!result.ok) return result;

  const remaining = pending.playersRemaining.filter((id) => id !== action.playerId);
  const nextState: GameState = { ...result.state, pendingGalacticCrisisPactOffer: remaining.length > 0 ? { ...pending, playersRemaining: remaining } : undefined };
  return { ok: true, state: nextState, events: result.events };
}

/** RR "Galactic Crisis Pact": the player declines to use the elected strategy card's secondary this time. */
export function skipGalacticCrisisPact(state: GameState, action: { type: "SKIP_GALACTIC_CRISIS_PACT"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingGalacticCrisisPactOffer;
  if (!pending || !pending.playersRemaining.includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Galactic Crisis Pact offer right now." };
  }
  const remaining = pending.playersRemaining.filter((id) => id !== action.playerId);
  return { ok: true, state: { ...state, pendingGalacticCrisisPactOffer: remaining.length > 0 ? { ...pending, playersRemaining: remaining } : undefined }, events: [] };
}
