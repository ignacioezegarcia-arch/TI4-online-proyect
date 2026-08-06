import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asAbilityId, ActionCardId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { hasAbility } from "./abilities";
import { drawActionCard } from "../phases/actionCards";
import { checkReinforcementsAvailable } from "./reinforcements";

/**
 * Yssaril Tribes "SCHEMING" (faction ability): "When you draw 1 or more
 * action cards, draw 1 additional action card. Then, choose and
 * discard 1 action card from your hand." Confirmed
 * (tirules2.com/F_yssaril):
 *  - No other abilities may resolve until the discard happens.
 *  - Applies whenever the Yssaril player draws action cards, from
 *    ANY source (confirmed via Fandom's own FAQ: even Neural
 *    Motivator's own status-phase draw triggers it).
 *  - Only draws 1 ADDITIONAL card total, regardless of how many cards
 *    they were instructed to draw in the first place.
 *  - The discarded card may be ANY card in hand — not necessarily one
 *    of the ones just drawn.
 *  - Effects that grant action cards WITHOUT drawing them (The Codex
 *    relic, Reverse Engineer action card, Mageon Implants below,
 *    Kyver's own Guild of Spies) do NOT trigger this.
 *
 * This is the shared core: given a normal draw count, returns the
 * ACTUAL count to draw (with SCHEMING's own +1, capped at +1
 * regardless of the original count) — callers thread this through
 * their own existing draw-N-cards logic, then separately prompt for
 * the mandatory discard afterward (discardSchemingCard below).
 */
export function applySchemingToDrawCount(player: Player, requestedCount: number): number {
  if (!hasAbility(player, asAbilityId("scheming")) || requestedCount <= 0) return requestedCount;
  return requestedCount + 1;
}

/**
 * Shared "draw N action cards for a player, with SCHEMING support"
 * helper — every draw site in this project should route through this
 * (instead of calling drawActionCard directly in a raw loop) so
 * SCHEMING is NEVER accidentally missed for a future draw site.
 * Confirmed (tirules2.com/F_yssaril): "If the Yssaril player duplicates
 * the Mentak player's Suffi An agent, then the Yssaril player and the
 * player targeted by Pillage will draw action cards [triggering
 * Scheming for whichever of those IS Yssaril]. The Mentak player will
 * not [own Scheming]" — confirming this applies to WHOEVER draws,
 * regardless of what triggered the draw or who initiated it, not just
 * "the player currently taking their turn."
 */
export function drawActionCardsForPlayer(
  state: GameState,
  playerId: PlayerId,
  requestedCount: number,
): { state: GameState; events: GameEvent[] } {
  if (requestedCount <= 0) return { state, events: [] };
  const player = state.players[playerId];
  const actualCount = applySchemingToDrawCount(player, requestedCount);

  let deck = state.actionCardDeck ?? [];
  let discardPile = state.actionCardDiscardPile ?? [];
  const drawnIds: string[] = [];
  for (let i = 0; i < actualCount; i++) {
    const draw = drawActionCard({ ...state, actionCardDeck: deck, actionCardDiscardPile: discardPile });
    deck = draw.deck;
    discardPile = draw.discardPile;
    if (draw.drawn) drawnIds.push(draw.drawn);
  }

  const events: GameEvent[] = drawnIds.map((cardId) => ({ type: "ACTION_CARD_DRAWN", playerId, cardId: cardId as never }));
  const updatedPlayer: Player = { ...player, actionCards: [...player.actionCards, ...(drawnIds as never[])] };
  let nextState: GameState = { ...state, actionCardDeck: deck, actionCardDiscardPile: discardPile, players: { ...state.players, [playerId]: updatedPlayer } };

  if (drawnIds.length > 0 && hasAbility(player, asAbilityId("scheming"))) {
    const alreadyPending = state.pendingSchemingDiscards ?? [];
    if (!alreadyPending.includes(playerId)) {
      nextState = { ...nextState, pendingSchemingDiscards: [...alreadyPending, playerId] };
    }
  }

  return { state: nextState, events };
}

/**
 * SCHEMING's own mandatory discard half — called once, after ANY
 * qualifying draw (regardless of how many cards were drawn), letting
 * the player discard any 1 card from their current hand.
 */
export function discardSchemingCard(state: GameState, action: { type: "DISCARD_SCHEMING_CARD"; playerId: PlayerId; cardId: string } ): ActionResult {
  const player = state.players[action.playerId];
  if (!hasAbility(player, asAbilityId("scheming"))) return { ok: false, error: "This player doesn't have SCHEMING." };
  if (!player.actionCards.includes(action.cardId as never)) return { ok: false, error: "This player doesn't have that action card." };

  const updatedPlayer: Player = { ...player, actionCards: player.actionCards.filter((id) => id !== (action.cardId as never)) };
  const remainingPending = (state.pendingSchemingDiscards ?? []).filter((id) => id !== action.playerId);
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [action.playerId]: updatedPlayer },
      actionCardDiscardPile: [...(state.actionCardDiscardPile ?? []), action.cardId as never],
      pendingSchemingDiscards: remainingPending.length > 0 ? remainingPending : undefined,
    },
    events: [],
  };
}

/**
 * Yssaril Tribes "CRAFTY" (faction ability): "You can have any number
 * of action cards in your hand. Game effects cannot prevent you from
 * using this ability." Confirmed (tirules2.com/F_yssaril): "the effect
 * of the Executive Sanctions law does not affect the Yssaril player" —
 * this project has no generic hand-size cap enforced anywhere to begin
 * with (no code currently discards down to a limit), so CRAFTY needs
 * no additional code of its own beyond this documented confirmation;
 * flagged here so a FUTURE hand-limit implementation (for factions
 * that don't have this) remembers to exempt Yssaril specifically.
 */
export function hasUnlimitedActionCardHand(player: Player): boolean {
  return hasAbility(player, asAbilityId("crafty"));
}

/**
 * Yssaril Tribes "STALL TACTICS" (faction ability): "ACTION: Discard 1
 * action card from your hand." No additional confirmed rulings beyond
 * the printed text.
 */
/**
 * Yssaril Tribes "STALL TACTICS" (faction ability): "ACTION: Discard 1
 * action card from your hand." No additional confirmed rulings beyond
 * the printed text.
 *
 * "Blackshade Infiltrator" (mech, Deploy): "After you use your STALL
 * TACTICS faction ability, you may place 1 mech on a planet you
 * control." — the player's own optional choice, via deployMechPlanetId
 * below.
 */
export function useStallTactics(state: GameState, action: { type: "USE_STALL_TACTICS"; playerId: PlayerId; cardId: string; deployMechPlanetId?: PlanetId } ): ActionResult {
  const player = state.players[action.playerId];
  if (!hasAbility(player, asAbilityId("stall_tactics"))) return { ok: false, error: "This player doesn't have STALL TACTICS." };
  if (!player.actionCards.includes(action.cardId as never)) return { ok: false, error: "This player doesn't have that action card." };

  const updatedPlayer: Player = { ...player, actionCards: player.actionCards.filter((id) => id !== (action.cardId as never)) };
  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, actionCardDiscardPile: [...(state.actionCardDiscardPile ?? []), action.cardId as never] };

  if (action.deployMechPlanetId) {
    let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      const planet = system.planets.find((p) => p.planetId === action.deployMechPlanetId);
      if (planet) {
        found = { systemId: systemId as SystemId, system, planet };
        break;
      }
    }
    if (!found || found.planet.controllerId !== action.playerId) {
      return { ok: false, error: "This player doesn't control that planet." };
    }
    const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.playerId, [{ unitType: "mech", count: 1 }]);
    if (!reinforcementsCheck.ok) return reinforcementsCheck;
    const stacks = found.planet.unitsByPlayer[action.playerId] ?? [];
    const existing = stacks.find((s) => s.unitType === "mech");
    const updatedStacks = existing ? stacks.map((s) => (s.unitType === "mech" ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "mech" as const, count: 1, damagedCount: 0 }];
    const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: updatedStacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.deployMechPlanetId ? updatedPlanet : p)) } } };
  }

  return { ok: true, state: nextState, events: [] };
}

function findYssarilPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("yssaril" as never))?.id;
}

/**
 * Yssaril Tribes "Spy Net" (promissory note): "At the start of your
 * turn: Look at the Yssaril player's hand of action cards. Choose 1 of
 * those cards and add it to your hand. Then, return this card to the
 * Yssaril player." Confirmed (tirules2.com/F_yssaril):
 *  - The player does not have to read/memorize what they look at (a
 *    real-world table-etiquette note, not something this project
 *    needs to model).
 *  - Any deal about which card gets chosen, made before the exchange,
 *    is non-binding — matches this project's own general non-
 *    enforcement of deals everywhere else.
 */
export function useSpyNet(state: GameState, action: { type: "USE_SPY_NET"; playerId: PlayerId; chosenCardId: string } ): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("yssaril_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Spy Net in hand." };
  }
  const yssarilPlayerId = findYssarilPlayerId(state);
  if (!yssarilPlayerId) return { ok: false, error: "No Yssaril player in this game." };
  const yssarilPlayer = state.players[yssarilPlayerId];
  if (!yssarilPlayer.actionCards.includes(action.chosenCardId as never)) {
    return { ok: false, error: "The Yssaril player doesn't have that action card." };
  }

  const updatedYssarilPlayer: Player = {
    ...yssarilPlayer,
    actionCards: yssarilPlayer.actionCards.filter((id) => id !== (action.chosenCardId as never)),
    promissoryNotesInHand: [...yssarilPlayer.promissoryNotesInHand, "yssaril_promissory" as never],
  };
  const updatedPlayer: Player = {
    ...player,
    actionCards: [...player.actionCards, action.chosenCardId as never],
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("yssaril_promissory" as never)),
  };

  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [yssarilPlayerId]: updatedYssarilPlayer } },
    events: [],
  };
}

/**
 * Yssaril Tribes "Mageon Implants" (faction tech, exhaustable): "ACTION:
 * Exhaust this card to look at another player's hand of action cards.
 * Choose 1 of those cards and add it to your hand." Confirmed
 * (tirules2.com/F_yssaril):
 *  - This is NOT "drawing" a card — SCHEMING does NOT trigger.
 *  - The target must have at least 1 action card in hand.
 *  - The Yssaril player cannot show the target's hand to any OTHER
 *    players (may describe it orally, truthfully or not — a
 *    table-etiquette note, not something this project needs to model
 *    mechanically).
 */
export function useMageonImplants(state: GameState, action: { type: "USE_MAGEON_IMPLANTS"; playerId: PlayerId; targetPlayerId: PlayerId; chosenCardId: string } ): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("mageon_implants" as never)) {
    return { ok: false, error: "This player doesn't have Mageon Implants." };
  }
  if (player.exhaustedTechnologies.includes("mageon_implants" as never)) {
    return { ok: false, error: "Mageon Implants is already exhausted." };
  }
  const target = state.players[action.targetPlayerId];
  if (!target || target.actionCards.length === 0) return { ok: false, error: "That player has no action cards in hand." };
  if (!target.actionCards.includes(action.chosenCardId as never)) return { ok: false, error: "That player doesn't have that action card." };

  const updatedTarget: Player = { ...target, actionCards: target.actionCards.filter((id) => id !== (action.chosenCardId as never)) };
  const updatedPlayer: Player = {
    ...player,
    actionCards: [...player.actionCards, action.chosenCardId as never],
    exhaustedTechnologies: [...player.exhaustedTechnologies, "mageon_implants" as never],
  };

  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [action.targetPlayerId]: updatedTarget } },
    events: [],
  };
}

/**
 * Yssaril Tribes "Transparasteel Plating" (faction tech): "During your
 * turn of the action phase, players that have passed cannot play
 * action cards." Confirmed (tirules2.com/F_yssaril): "other players
 * may still resolve faction abilities, leader abilities, or technology
 * abilities during the Yssaril player's turns" — this restriction is
 * SPECIFICALLY scoped to action cards, nothing broader. Checked here
 * as a simple predicate — the caller (wherever this project validates
 * "may this player play an action card right now") consults this
 * during the Yssaril player's own active turn.
 */
export function isBlockedByTransparasteelPlating(state: GameState, activePlayerId: PlayerId, cardPlayerId: PlayerId): boolean {
  const activePlayer = state.players[activePlayerId];
  if (activePlayer?.factionId !== ("yssaril" as never) || !activePlayer.technologies.includes("transparasteel_plating" as never)) return false;
  if (activePlayerId === cardPlayerId) return false;
  return !!state.players[cardPlayerId]?.hasPassed;
}

/**
 * Yssaril Tribes "Ssruu" (agent): "This card has the text ability of
 * each other player's agent, even if that agent is exhausted."
 * Confirmed (tirules2.com/F_yssaril): scoped to agents belonging to
 * OTHER PLAYERS ACTUALLY IN THIS GAME (not every agent that exists in
 * the full card pool) — confirmed directly by the user. Several
 * cross-faction interaction notes exist (Captain Mendosa timing,
 * Stillness of Stars resolution order, Suffi An triggering Scheming,
 * Trillossa Aun Mirik/Emissary Taivra/Doctor Sucaban same-window
 * exceptions, The Thundarian mutual exclusion) — these are all
 * per-target-agent nuances handled by whichever underlying function
 * gets invoked, not something this shared validator needs to know
 * about.
 *
 * FORWARD-COMPATIBILITY REQUIREMENT (confirmed by the user — this
 * project still has ~18 more official factions to implement, and
 * potentially dozens more fan-made Discordant Stars factions later):
 * this whole mechanism is GENERIC and requires ZERO additional code
 * for each new faction, on ONE condition — every future faction's own
 * agent MUST keep using the `{factionId}_agent` leader id convention
 * already enforced for all 12 factions built so far (verified directly
 * against every "leaderId ===" check in this codebase). As long as
 * that convention holds, GameEngine.ts's own USE_SSRUU case (which
 * builds `${targetFactionId}_agent` as a plain string) and its own
 * dispatchAction switch (which just needs that NEW faction's own agent
 * action wired in normally, as every other faction's already is) pick
 * up the new agent automatically — no faction-specific work in this
 * file, ever, unless that convention is ever broken.
 *
 * IMPLEMENTATION APPROACH: rather than a generic "copy ability text"
 * engine, GameEngine.ts's own USE_SSRUU case temporarily loans a
 * synthetic, unexhausted `{targetFactionId}_agent` leader entry onto
 * the Yssaril player (satisfying that agent's own "do I own this
 * leader" check), re-dispatches the SAME underlying action any other
 * player would submit for that agent (with playerId/ownerId swapped to
 * the Yssaril player), then strips the loaned entry back out and
 * exhausts SSRUU ITSELF instead (not the duplicated agent — the
 * duplicated agent's own real owner keeps their own exhaustion status
 * untouched, matching "even if that agent is exhausted"). This function
 * is the shared validation + loan/cleanup half; GameEngine.ts's own
 * switch case does the actual re-dispatch.
 */
export function checkSsruuAndTarget(state: GameState, playerId: PlayerId, targetFactionId: string): { ok: true; targetPlayerId: PlayerId } | { ok: false; error: string } {
  const player = state.players[playerId];
  const agentEntry = player.leaders.find((l) => l.leaderId === ("yssaril_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have Ssruu." };
  if (agentEntry.exhausted) return { ok: false, error: "Ssruu is already exhausted." };
  if (targetFactionId === "yssaril") return { ok: false, error: "Ssruu cannot duplicate itself." };

  const targetPlayer = Object.values(state.players).find((p) => p.factionId === (targetFactionId as never));
  if (!targetPlayer) return { ok: false, error: `No ${targetFactionId} player in this game — Ssruu can only duplicate an agent actually in play.` };

  return { ok: true, targetPlayerId: targetPlayer.id };
}

/** Loans a synthetic, unexhausted `{targetFactionId}_agent` leader entry onto the Yssaril player, for GameEngine.ts's own USE_SSRUU re-dispatch. */
export function loanAgentLeader(state: GameState, playerId: PlayerId, syntheticLeaderId: string): GameState {
  const player = state.players[playerId];
  return { ...state, players: { ...state.players, [playerId]: { ...player, leaders: [...player.leaders, { leaderId: syntheticLeaderId as never, locked: false, exhausted: false }] } } };
}

/** Strips the loaned synthetic leader back out, and exhausts SSRUU ITSELF instead — see checkSsruuAndTarget's own doc comment above. */
export function returnLoanedAgentLeaderAndExhaustSsruu(state: GameState, playerId: PlayerId, syntheticLeaderId: string): GameState {
  const player = state.players[playerId];
  const strippedLeaders = player.leaders.filter((l) => l.leaderId !== (syntheticLeaderId as never));
  const finalLeaders = strippedLeaders.map((l) => (l.leaderId === ("yssaril_agent" as never) ? { ...l, exhausted: true } : l));
  return { ...state, players: { ...state.players, [playerId]: { ...player, leaders: finalLeaders } } };
}

/**
 * Yssaril Tribes "So Ata" (commander): "After another player activates
 * a system that contains your units: You may look at that player's
 * action cards, promissory notes, or secret objectives." Unlock:
 * "Have 7 action cards." Confirmed (tirules2.com/F_yssaril): "the
 * Yssaril player cannot unlock So Ata if they are yet to discard a
 * card for their Scheming ability" — the unlock check itself must
 * consult pendingSchemingDiscards (if this player has a pending
 * discard, their action-card COUNT temporarily includes cards they're
 * about to lose, so unlocking off that inflated count isn't valid
 * yet). This function is a pure, read-only query (look at hand
 * contents) — no state change, since it's informational only (this
 * project's own architecture exposes full state directly, same
 * reasoning as Naalu's own M'aban Ω).
 */
export function canUnlockSoAta(state: GameState, playerId: PlayerId): boolean {
  const player = state.players[playerId];
  if ((state.pendingSchemingDiscards ?? []).includes(playerId)) return false;
  return player.actionCards.length >= 7;
}

/**
 * Yssaril Tribes "So Ata" (commander): the ACTUAL reactive ability half
 * — "After another player activates a system that contains your
 * units: You may look at that player's action cards, promissory
 * notes, or secret objectives." Confirmed
 * (tirules2.com/F_yssaril — see canUnlockSoAta above for the separate
 * unlock-eligibility rule). Validates the trigger condition (must be
 * unlocked, must have this player's own units in the JUST-activated
 * system, activator must not be this player themselves); the "look"
 * itself needs no state change (this project's own architecture
 * exposes full state directly, same reasoning as Naalu's own M'aban Ω)
 * — this is a pure eligibility check the caller uses before deciding
 * whether to actually surface that information to the player.
 */
export function canUseSoAta(state: GameState, playerId: PlayerId, activatingPlayerId: PlayerId, activatedSystemId: SystemId): boolean {
  const player = state.players[playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("yssaril_commander" as never));
  if (!commanderEntry || commanderEntry.locked) return false;
  if (activatingPlayerId === playerId) return false;
  const system = state.systems[activatedSystemId];
  if (!system) return false;
  const hasUnitsInSpace = (system.spaceUnitsByPlayer[playerId] ?? []).some((s) => s.count > 0);
  const hasUnitsOnPlanet = system.planets.some((p) => (p.unitsByPlayer[playerId] ?? []).some((s) => s.count > 0));
  return hasUnitsInSpace || hasUnitsOnPlanet;
}

/**
 * Yssaril Tribes "Kyver, Blade and Key — GUILD OF SPIES" (hero,
 * single-use): "ACTION: Each other player shows you 1 action card from
 * their hand. For each player, you may either take that card or force
 * that player to discard 3 random action cards from their hand. Then,
 * purge this card." Confirmed (tirules2.com/F_yssaril): "each other
 * player chooses WHICH action card they show" (the caller supplies
 * that target's own choice here, same convention as this project's
 * other "affected player's own choice, submitted by whoever calls the
 * action" cases) — "taking action cards this way does NOT trigger
 * Scheming" (this isn't a "draw").
 */
export function useGuildOfSpies(
  state: GameState,
  action: { type: "USE_GUILD_OF_SPIES"; playerId: PlayerId; choices: { targetPlayerId: PlayerId; shownCardId: string; take: boolean }[] },
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("yssaril_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Kyver, Blade and Key." };

  const otherPlayerIds = Object.values(state.players)
    .filter((p) => p.id !== action.playerId && !p.eliminated)
    .map((p) => p.id);
  const providedIds = new Set(action.choices.map((c) => c.targetPlayerId));
  for (const id of otherPlayerIds) {
    if (!providedIds.has(id)) return { ok: false, error: `Missing a choice for ${id}.` };
  }

  let players = state.players;
  let deck = state.actionCardDeck ?? [];
  let discardPile = state.actionCardDiscardPile ?? [];
  for (const { targetPlayerId, shownCardId, take } of action.choices) {
    const target = players[targetPlayerId];
    if (!target.actionCards.includes(shownCardId as never)) {
      return { ok: false, error: `${targetPlayerId} doesn't have that action card.` };
    }
    if (take) {
      players = {
        ...players,
        [targetPlayerId]: { ...target, actionCards: target.actionCards.filter((id) => id !== (shownCardId as never)) },
        [action.playerId]: { ...players[action.playerId], actionCards: [...players[action.playerId].actionCards, shownCardId as never] },
      };
    } else {
      const currentTarget = players[targetPlayerId];
      const shuffled = [...currentTarget.actionCards].sort(() => Math.random() - 0.5);
      const toDiscard = shuffled.slice(0, 3);
      discardPile = [...discardPile, ...(toDiscard as never[])];
      players = { ...players, [targetPlayerId]: { ...currentTarget, actionCards: currentTarget.actionCards.filter((id) => !toDiscard.includes(id)) } };
    }
  }

  const updatedPlayer: Player = { ...players[action.playerId], leaders: players[action.playerId].leaders.filter((l) => l.leaderId !== ("yssaril_hero" as never)) };
  return { ok: true, state: { ...state, players: { ...players, [action.playerId]: updatedPlayer }, actionCardDeck: deck, actionCardDiscardPile: discardPile }, events: [] };
}

/**
 * Yssaril Tribes "Deepgloom Executable" (Breakthrough ability): "You
 * can allow other players to use your STALL TACTICS or SCHEMING
 * faction abilities; when you do, you may resolve a transaction with
 * that player. During the action phase, that transaction does not
 * count against the once-per-player transactions limit for that turn."
 * Confirmed (tirules2.com/F_yssaril):
 *  - The Yssaril player may perform this transaction with another
 *    player WITHOUT being neighbors.
 *  - May perform it even if NEITHER player is the active player.
 *  - Can enable a transaction at a time this player usually couldn't
 *    (e.g. during another player's own reactive ability window).
 *
 * The actual mechanics live directly in rules/transactions.ts's own
 * canTransact/resolveTransaction (their own deepgloomExecutableActive
 * parameter) — this is a validation-only check the caller uses before
 * submitting a PROPOSE_TRANSACTION with that flag set, confirming this
 * player genuinely has the Breakthrough before letting them bypass the
 * normal neighbor/once-per-turn restrictions.
 */
export function hasDeepgloomExecutable(player: Player): boolean {
  return player.hasBreakthrough === true && player.factionId === ("yssaril" as never);
}
