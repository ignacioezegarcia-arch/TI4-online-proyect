import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId } from "../types/ids";
import { ThunderEdgeExpeditionSliceCost } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { grantBreakthrough } from "../rules/breakthroughs";

/**
 * TE Thunder's Edge Expedition (rulebook p.9): 6 distinct costs, each
 * claimable by at most 1 player total across the whole game — "a player
 * can claim multiple expedition slices in a game, but must choose a
 * different unclaimed slice each time they do so." Whoever claims a
 * slice pays it immediately as part of this same action.
 *
 * Timing note: the rulebook's own trigger is "at the end of a player's
 * turn" — this project doesn't have a dedicated generic "end of turn"
 * window built yet (a broader concept than just this one card), so this
 * is gated the same way this project's own Master Plan/War Machine
 * action cards are — playable any time it's this player's own turn
 * during the action phase — which covers the intended moment (their own
 * turn) without yet modeling the more precise "specifically at the very
 * end of it" sub-timing. Worth tightening once a real end-of-turn window
 * exists for other abilities to share.
 */
export function claimExpeditionSlice(
  state: GameState,
  action: {
    type: "CLAIM_EXPEDITION_SLICE";
    playerId: PlayerId;
    slice: ThunderEdgeExpeditionSliceCost;
    /** Only meaningful for the "resources"/"influence" slices — which planets to exhaust to cover the cost (5 resources or 5 influence respectively). */
    exhaustPlanetIds?: PlanetId[];
    /** Only meaningful for the "action_cards" slice — exactly 2 action card ids from this player's own hand to discard. */
    discardActionCardIds?: string[];
    /** Only meaningful for the "secret_objective" slice — exactly 1 UNSCORED secret objective id from this player's own hand to discard. */
    discardSecretObjectiveId?: string;
    /** Only meaningful for the "tech_specialty_planet" slice — which of this player's own tech-specialty planets to exhaust. */
    exhaustTechSpecialtyPlanetId?: PlanetId;
    /** Trusted-RNG-style input this function itself doesn't need, but grantBreakthrough (called when this is this player's FIRST claim) does, for its own Fracture-roll — see that function's own doc comment. */
    fractureDieRoll?: number;
  },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "action" || state.activePlayerId !== action.playerId) {
    return { ok: false, error: "Thunder's Edge Expedition: only claimable on this player's own turn during the action phase." };
  }
  if (state.thunderEdgeExpedition.completed) {
    return { ok: false, error: "Thunder's Edge Expedition: already complete — nothing left to claim." };
  }
  if (state.thunderEdgeExpedition.slicesClaimedBy[action.slice]) {
    return { ok: false, error: `Thunder's Edge Expedition: the "${action.slice}" slice is already claimed.` };
  }

  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };

  let updatedPlayer: Player = player;
  let systems = state.systems;
  const events: GameEvent[] = [];

  switch (action.slice) {
    case "trade_goods": {
      if (player.tradeGoods < 3) return { ok: false, error: "Not enough trade goods (need 3)." };
      updatedPlayer = { ...updatedPlayer, tradeGoods: updatedPlayer.tradeGoods - 3 };
      break;
    }
    case "action_cards": {
      const ids = action.discardActionCardIds ?? [];
      if (ids.length !== 2 || !ids.every((id) => player.actionCards.includes(id as never))) {
        return { ok: false, error: "Must discard exactly 2 action cards from this player's own hand." };
      }
      const remaining = [...player.actionCards];
      for (const id of ids) {
        const idx = remaining.indexOf(id as never);
        if (idx >= 0) remaining.splice(idx, 1);
      }
      updatedPlayer = { ...updatedPlayer, actionCards: remaining };
      break;
    }
    case "secret_objective": {
      const id = action.discardSecretObjectiveId;
      if (!id || !player.secretObjectives.includes(id as never) || player.victoryPoints.scoredObjectiveIds.includes(id as never)) {
        return { ok: false, error: "Must discard exactly 1 UNSCORED secret objective from this player's own hand." };
      }
      updatedPlayer = { ...updatedPlayer, secretObjectives: player.secretObjectives.filter((o) => o !== id) };
      break;
    }
    case "resources": {
      const spend = spendExhaustingPlanets(state, action.playerId, action.exhaustPlanetIds ?? [], "resources", 5, rules);
      if (!spend.ok) return spend;
      systems = spend.systems;
      break;
    }
    case "influence": {
      const spend = spendExhaustingPlanets(state, action.playerId, action.exhaustPlanetIds ?? [], "influence", 5, rules);
      if (!spend.ok) return spend;
      systems = spend.systems;
      break;
    }
    case "tech_specialty_planet": {
      const planetId = action.exhaustTechSpecialtyPlanetId;
      if (!planetId) return { ok: false, error: "Must specify which technology-specialty planet to exhaust." };
      const found = findPlanetHere(systems, planetId);
      if (!found || found.planet.controllerId !== action.playerId) {
        return { ok: false, error: "This player doesn't control that planet." };
      }
      if (found.planet.exhausted) return { ok: false, error: "That planet is already exhausted." };
      if ((rules.planets[planetId]?.techSpecialties ?? []).length === 0) {
        return { ok: false, error: "That planet has no technology specialty." };
      }
      const updatedPlanet: PlanetState = { ...found.planet, exhausted: true };
      systems = { ...systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } };
      events.push({ type: "PLANET_EXHAUSTED", playerId: action.playerId, planetId });
      break;
    }
  }

  let nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    systems,
    thunderEdgeExpedition: { ...state.thunderEdgeExpedition, slicesClaimedBy: { ...state.thunderEdgeExpedition.slicesClaimedBy, [action.slice]: action.playerId } },
  };
  events.push({ type: "EXPEDITION_SLICE_CLAIMED", playerId: action.playerId, slice: action.slice });

  // "The first time a player claims one of the expedition slices, they gain their faction's breakthrough."
  if (!player.hasBreakthrough) {
    const granted = grantBreakthrough(nextState, action.playerId, rules, action.fractureDieRoll);
    nextState = granted.state;
    events.push(...granted.events);
  }

  return { ok: true, state: nextState, events };
}

/** Shared by the "resources" and "influence" slice costs — same exhaust-planets-for-a-fixed-amount shape this project already uses elsewhere (e.g. RR 27.2's own custodians-token removal), just factored out here since the expedition needs it for 2 different resource types. */
function spendExhaustingPlanets(
  state: GameState,
  playerId: PlayerId,
  planetIds: PlanetId[],
  kind: "resources" | "influence",
  amountNeeded: number,
  rules: RuleData,
): { ok: true; systems: GameState["systems"] } | { ok: false; error: string } {
  let total = 0;
  let systems = state.systems;
  for (const planetId of planetIds) {
    const found = findPlanetHere(systems, planetId);
    if (!found || found.planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (found.planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    total += rules.planets[planetId]?.[kind] ?? 0;
    const updatedPlanet: PlanetState = { ...found.planet, exhausted: true };
    systems = { ...systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } };
  }
  if (total < amountNeeded) return { ok: false, error: `Not enough ${kind} from the exhausted planets (need ${amountNeeded}, got ${total}).` };
  return { ok: true, systems };
}

function findPlanetHere(systems: GameState["systems"], planetId: PlanetId): { systemId: SystemId; system: SystemState; planet: PlanetState } | null {
  for (const [systemId, system] of Object.entries(systems)) {
    const planet = system.planets.find((p) => p.planetId === planetId);
    if (planet) return { systemId: systemId as SystemId, system, planet };
  }
  return null;
}

/**
 * TE Thunder's Edge Expedition completion (rulebook p.9): once all 6
 * slices are claimed, the player who claimed the LAST one flips the
 * planet face-up and places it in a system of their choice that
 * contains no planet, no supernova, and no printed wormhole (and not in
 * The Fracture — see rules/theFracture.ts once that's built). Then,
 * whichever player holds the MOST claimed slices overall places that
 * many infantry on it; a tie is broken by the final-slice claimer's own
 * choice of which tied player does so.
 */
export function completeThunderEdgeExpedition(
  state: GameState,
  action: { type: "COMPLETE_THUNDER_EDGE_EXPEDITION"; playerId: PlayerId; targetSystemId: SystemId; infantryPlacingPlayerId?: PlayerId; fractureDieRoll?: number },
  rules: RuleData,
): ActionResult {
  if (state.thunderEdgeExpedition.completed) {
    return { ok: false, error: "Thunder's Edge Expedition: already complete." };
  }
  const claims = Object.values(state.thunderEdgeExpedition.slicesClaimedBy).filter((id): id is PlayerId => Boolean(id));
  if (claims.length < 6) {
    return { ok: false, error: "Thunder's Edge Expedition: not all 6 slices have been claimed yet." };
  }
  const lastSliceClaimerId = Object.entries(state.thunderEdgeExpedition.slicesClaimedBy).slice(-1)[0]?.[1];
  if (lastSliceClaimerId !== action.playerId) {
    return { ok: false, error: "Thunder's Edge Expedition: only the player who claimed the final slice places the planet." };
  }

  const system = state.systems[action.targetSystemId];
  if (!system) return { ok: false, error: `No system ${action.targetSystemId}.` };
  if (system.planets.length > 0) return { ok: false, error: "Thunder's Edge cannot be placed in a system that already has a planet." };
  if (system.anomalies.includes("supernova")) return { ok: false, error: "Thunder's Edge cannot be placed in a system with a supernova." };
  if (system.wormholes.length > 0) return { ok: false, error: "Thunder's Edge cannot be placed in a system with a printed wormhole." };
  if (system.isFracture) return { ok: false, error: "Thunder's Edge cannot be placed in The Fracture." };

  const counts = new Map<PlayerId, number>();
  for (const id of claims) counts.set(id, (counts.get(id) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  const tiedPlayers = Array.from(counts.entries()).filter(([, c]) => c === maxCount).map(([id]) => id);
  let infantryPlacingPlayerId: PlayerId;
  if (tiedPlayers.length === 1) {
    infantryPlacingPlayerId = tiedPlayers[0];
  } else {
    if (!action.infantryPlacingPlayerId || !tiedPlayers.includes(action.infantryPlacingPlayerId)) {
      return { ok: false, error: "Tied for most claimed slices — infantryPlacingPlayerId must specify which of the tied players places infantry." };
    }
    infantryPlacingPlayerId = action.infantryPlacingPlayerId;
  }
  const infantryCount = maxCount;

  const thunderEdgePlanet: PlanetState = {
    planetId: "thunders_edge" as PlanetId,
    // RR (FFG's own official preview, ti4.dronz.co reference): "the player who claimed the most slices gains control" — previously left uncontrolled (null), which was wrong.
    controllerId: infantryPlacingPlayerId,
    exhausted: true, // gained control = exhausted, the normal rule (Jupiter Brain's own text doesn't say otherwise, unlike Muaat's Avernus/Stellar Genesis which explicitly does)
    legendaryAbilityExhausted: false,
    explored: false,
    attachmentIds: [],
    exhaustedAttachmentIds: [],
    unitsByPlayer: { [infantryPlacingPlayerId]: [{ unitType: "infantry", count: infantryCount, damagedCount: 0 }] },
  };
  const updatedSystem: SystemState = { ...system, planets: [...system.planets, thunderEdgePlanet] };

  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [action.targetSystemId]: updatedSystem },
    thunderEdgeExpedition: { ...state.thunderEdgeExpedition, completed: true },
  };
  const events: GameEvent[] = [{ type: "THUNDER_EDGE_EXPEDITION_COMPLETED", systemId: action.targetSystemId, infantryPlacingPlayerId, infantryCount }];

  // "Jupiter Brain" (Thunder's Edge's own legendary ability, CORRECTED — a previous session note here wrongly claimed this planet had no ability card at all): "Gain your breakthrough when you gain this card if you do not already have it."
  if (!nextState.players[infantryPlacingPlayerId]?.hasBreakthrough) {
    const granted = grantBreakthrough(nextState, infantryPlacingPlayerId, rules, action.fractureDieRoll);
    nextState = granted.state;
    events.push(...granted.events);
  }

  return { ok: true, state: nextState, events };
}
