import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, StrategyCardId, asRelicId } from "../types/ids";
import { GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { checkReinforcementsAvailable } from "./reinforcements";
import { getAdjacentSystems } from "./adjacency";

/**
 * Winnu "RECLAMATION" (faction ability): "After you resolve a tactical
 * action during which you gained control of Mecatol Rex, you may place
 * 1 PDS and 1 space dock from your reinforcements on Mecatol Rex."
 * Confirmed (yjmrobert.com/tirules/factions/f_winnu): "Placing the
 * structure will occur after the Production step. If the Winnu player
 * places a Space Dock, they cannot produce out of it during the same
 * action" — this is why it's modeled as its own follow-up action (called
 * once the whole tactical action is otherwise done), never folded into
 * the normal Production step itself.
 */
export function useReclamation(
  state: GameState,
  action: { type: "USE_RECLAMATION"; playerId: PlayerId; placePds: boolean; placeSpaceDock: boolean },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingReclamationChoice;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "No pending Reclamation for this player." };
  }
  const mecatolSystemId = rules.mecatolSystemId as SystemId;
  const system = state.systems[mecatolSystemId];
  const mecatolPlanet = system?.planets.find((p) => rules.planets[p.planetId]?.isMecatolRex);
  if (!system || !mecatolPlanet || mecatolPlanet.controllerId !== action.playerId) {
    return { ok: false, error: "This player no longer controls Mecatol Rex." };
  }

  let nextState: GameState = { ...state, pendingReclamationChoice: undefined };
  const toPlace: { unitType: "pds" | "space_dock" }[] = [];
  if (action.placePds) toPlace.push({ unitType: "pds" });
  if (action.placeSpaceDock) toPlace.push({ unitType: "space_dock" });

  for (const { unitType } of toPlace) {
    const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.playerId, [{ unitType, count: 1 }]);
    // Confirmed: "If the Winnu player has no PDS or Space Docks left in
    // their reinforcements, they may remove a unit from any system that
    // does not contain one of their command tokens and place that unit
    // on Mecatol Rex" — same substitution shape as "Freelancers"
    // elsewhere in this project, but unconditional here (no exploration
    // card needed) since it's this ability's own printed text.
    if (!reinforcementsCheck.ok) {
      const sourceEntry = Object.entries(nextState.systems).find(
        ([sid, s]) => sid !== mecatolSystemId && !nextState.players[action.playerId].commandTokens.onBoard.includes(sid as SystemId) && (s.planets.some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((st) => st.unitType === unitType && st.count > 0))),
      );
      if (!sourceEntry) return { ok: false, error: `No ${unitType} available in reinforcements or elsewhere to place on Mecatol Rex.` };
      const [sourceSystemId, sourceSystem] = sourceEntry;
      const sourcePlanet = sourceSystem.planets.find((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === unitType && s.count > 0))!;
      const sourceStacks = (sourcePlanet.unitsByPlayer[action.playerId] ?? []).map((s) => (s.unitType === unitType ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
      const updatedSourcePlanet: PlanetState = { ...sourcePlanet, unitsByPlayer: { ...sourcePlanet.unitsByPlayer, [action.playerId]: sourceStacks } };
      nextState = { ...nextState, systems: { ...nextState.systems, [sourceSystemId]: { ...sourceSystem, planets: sourceSystem.planets.map((p) => (p.planetId === sourcePlanet.planetId ? updatedSourcePlanet : p)) } } };
    }
    const currentMecatol = nextState.systems[mecatolSystemId].planets.find((p) => p.planetId === mecatolPlanet.planetId)!;
    const stacks = (currentMecatol.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === unitType);
    if (existing) existing.count += 1;
    else stacks.push({ unitType, count: 1, damagedCount: 0 });
    const updatedMecatol: PlanetState = { ...currentMecatol, unitsByPlayer: { ...currentMecatol.unitsByPlayer, [action.playerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [mecatolSystemId]: { ...nextState.systems[mecatolSystemId], planets: nextState.systems[mecatolSystemId].planets.map((p) => (p.planetId === mecatolPlanet.planetId ? updatedMecatol : p)) } } };
  }

  return { ok: true, state: nextState, events: [] };
}

/**
 * Winnu "Reclaimer" (mech): same mechanic as RECLAMATION above, but for
 * ANY planet the mech sits on (not just Mecatol), and EITHER 1 PDS OR 1
 * space dock (not both). Confirmed: "The Reclaimer need only be on the
 * planet at the end of the tactical action the Winnu player gained it,
 * not when the Winnu player gains control of it" and "if the Winnu
 * player gains control of a planet with multiple Reclaimers, they may
 * place a structure for each one" — both handled here by checking the
 * mech count CURRENTLY on the planet (not at the moment control changed)
 * and looping once per Reclaimer present, up to the normal per-planet
 * structure limits enforced by placeStructuresFree's own callers
 * elsewhere (this function only places 1 structure per Reclaimer, the
 * limit check itself lives with the general structure-placement rules).
 */
export function useReclaimerPlacement(
  state: GameState,
  action: { type: "USE_RECLAIMER_PLACEMENT"; playerId: PlayerId; planetId: PlanetId; placements: ("pds" | "space_dock")[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingReclaimerChoice ?? [];
  const entry = pending.find((e) => e.playerId === action.playerId && e.planetId === action.planetId);
  if (!entry) return { ok: false, error: "No pending Reclaimer placement for this player on that planet." };

  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.planetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found || found.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player no longer controls that planet." };
  }
  const mechCount = (found.planet.unitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "mech" && s.count > 0)?.count ?? 0;
  if (action.placements.length > mechCount) {
    return { ok: false, error: `Only ${mechCount} Reclaimer(s) present — cannot place ${action.placements.length} structures.` };
  }

  let nextState: GameState = { ...state, pendingReclaimerChoice: pending.filter((e) => e !== entry) };
  for (const unitType of action.placements) {
    const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.playerId, [{ unitType, count: 1 }]);
    if (!reinforcementsCheck.ok) {
      const sourceEntry = Object.entries(nextState.systems).find(
        ([sid, s]) => sid !== found!.systemId && !nextState.players[action.playerId].commandTokens.onBoard.includes(sid as SystemId) && s.planets.some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((st) => st.unitType === unitType && st.count > 0)),
      );
      if (!sourceEntry) return { ok: false, error: `No ${unitType} available in reinforcements or elsewhere.` };
      const [sourceSystemId, sourceSystem] = sourceEntry;
      const sourcePlanet = sourceSystem.planets.find((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === unitType && s.count > 0))!;
      const sourceStacks = (sourcePlanet.unitsByPlayer[action.playerId] ?? []).map((s) => (s.unitType === unitType ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
      const updatedSourcePlanet: PlanetState = { ...sourcePlanet, unitsByPlayer: { ...sourcePlanet.unitsByPlayer, [action.playerId]: sourceStacks } };
      nextState = { ...nextState, systems: { ...nextState.systems, [sourceSystemId]: { ...sourceSystem, planets: sourceSystem.planets.map((p) => (p.planetId === sourcePlanet.planetId ? updatedSourcePlanet : p)) } } };
    }
    const currentPlanet = nextState.systems[found.systemId].planets.find((p) => p.planetId === action.planetId)!;
    const stacks = (currentPlanet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === unitType);
    if (existing) existing.count += 1;
    else stacks.push({ unitType, count: 1, damagedCount: 0 });
    const updatedPlanet: PlanetState = { ...currentPlanet, unitsByPlayer: { ...currentPlanet.unitsByPlayer, [action.playerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...nextState.systems[found.systemId], planets: nextState.systems[found.systemId].planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) } } };
  }

  return { ok: true, state: nextState, events: [] };
}

/**
 * Winnu "Acquiescence" (promissory note, original): "At the end of the
 * strategy phase: Exchange 1 of your strategy cards with a strategy card
 * that was chosen by the Winnu player." Modeled with both swapped
 * cardIds as explicit parameters (trusting the caller — same convention
 * this project already uses for other promissory notes whose exact
 * negotiation happens off-model) rather than trying to encode "chosen by
 * the Winnu player" as a hard rule here. Confirmed
 * (yjmrobert.com/tirules/factions/f_winnu): trade goods already on a
 * strategy card at the start of the strategy phase are unaffected by
 * this swap — moot in this engine, since a claimed card's own trade
 * goods are already paid out to whoever claimed it at pick time, never
 * tracked as "belonging to the card" afterward.
 */
export function usePlayAcquiescence(
  state: GameState,
  action: { type: "USE_PLAY_ACQUIESCENCE"; playerId: PlayerId; ownCardId: StrategyCardId; winnuCardId: StrategyCardId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.promissoryNotesInHand.includes("winnu_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Acquiescence in hand." };
  }
  const winnuId = Object.values(state.players).find((p) => p.factionId === ("winnu" as never))?.id;
  if (!winnuId) return { ok: false, error: "No Winnu player in this game." };
  const winnuPlayer = state.players[winnuId];

  const ownEntry = player.strategyCards.find((c) => c.cardId === action.ownCardId);
  const winnuEntry = winnuPlayer.strategyCards.find((c) => c.cardId === action.winnuCardId);
  if (!ownEntry || !winnuEntry) return { ok: false, error: "One of those strategy cards isn't actually held by the expected player." };

  const updatedOwnCards = player.strategyCards.map((c) => (c.cardId === action.ownCardId ? { ...winnuEntry } : c));
  const updatedWinnuCards = winnuPlayer.strategyCards.map((c) => (c.cardId === action.winnuCardId ? { ...ownEntry } : c));

  return {
    ok: true,
    state: {
      ...state,
      players: {
        ...state.players,
        [action.playerId]: { ...player, strategyCards: updatedOwnCards, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("winnu_promissory" as never)) },
        [winnuId]: { ...winnuPlayer, strategyCards: updatedWinnuCards },
      },
    },
    events: [],
  };
}

/**
 * Winnu "Acquiescence Ω" (promissory note, codex): "When the Winnu
 * player resolves a strategic action: You do not have to spend or place
 * a command token to resolve the secondary ability of that strategy
 * card. Then, return this card to the Winnu player." Queued here (WHEN
 * Winnu activates a strategy card) rather than resolved immediately,
 * since the actual free-secondary benefit only applies later, when the
 * holder themselves chooses to resolve that same card's secondary — see
 * phases/strategyCardAbilities.ts's own resolveStrategySecondary, which
 * checks GameState.pendingAcquiescenceOmegaFreeSecondary. Confirmed:
 * "cannot be triggered by" Winnu's own hero Mathis Mathinus's ability
 * (a DIFFERENT, unrelated way to get a free secondary) — that ability
 * lives entirely in phases/strategyCardAbilities.ts's own resolveMathis
 * Mathinus path, never sets this same pending field, so the two can't
 * accidentally combine.
 */
export function usePlayAcquiescenceOmega(
  state: GameState,
  action: { type: "USE_PLAY_ACQUIESCENCE_OMEGA"; playerId: PlayerId; strategyCardId: StrategyCardId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.promissoryNotesInHand.includes("winnu_promissory_omega" as never)) {
    return { ok: false, error: "This player doesn't have Acquiescence Ω in hand." };
  }
  const winnuId = Object.values(state.players).find((p) => p.factionId === ("winnu" as never))?.id;
  if (!winnuId) return { ok: false, error: "No Winnu player in this game." };
  const winnuPlayer = state.players[winnuId];
  // "When the Winnu player resolves a strategic action" — trusted to the
  // same real-time moment the caller submits this (right alongside
  // Winnu's own RESOLVE_STRATEGY_PRIMARY for this card), since this
  // project's action model has no persistent "currently resolving
  // strategy card" state to validate against — only that Winnu actually
  // still holds (hasn't yet used) that card this round.
  if (!winnuPlayer.strategyCards.some((c) => c.cardId === action.strategyCardId)) {
    return { ok: false, error: "The Winnu player doesn't hold that strategy card this round." };
  }

  const updatedPlayer: Player = { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("winnu_promissory_omega" as never)) };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, pendingAcquiescenceOmegaFreeSecondary: { playerId: action.playerId, cardId: action.strategyCardId } },
    events: [],
  };
}

/**
 * Winnu "Lazax Gate Folding" (faction technology), component-action half:
 * "ACTION: If you control Mecatol Rex, exhaust this card to place 1
 * infantry from your reinforcements on Mecatol Rex." Confirmed
 * (yjmrobert.com/tirules/factions/f_winnu): "The Winnu player may use
 * the component action if they do NOT control Mecatol Rex — if they do,
 * they must exhaust it, and there will be no additional effect" — i.e.
 * always legal to exhaust, the infantry placement only happens if they
 * actually control Mecatol Rex at that moment.
 *
 * The OTHER half of this tech (treating Mecatol Rex as if it had both an
 * alpha and beta wormhole during Winnu's own tactical actions, when they
 * don't control it) is a passive, always-on movement/adjacency effect —
 * see rules/adjacency.ts's own getAdjacentSystems, which checks this
 * same "lazax_gate_folding" tech directly rather than needing any state
 * here. NOT specifically handled: the narrower cross-player interactions
 * this same tech enables (other players retreating into/out of Mecatol
 * via the wormhole, Deep Space Cannon reaching through it, Creuss's own
 * Dimensional Splicer working there) — flagged rather than silently
 * assumed covered, since Deep Space Cannon specifically isn't modeled as
 * a generic mechanic anywhere in this project yet.
 */
export function useLazaxGateFolding(state: GameState, action: { type: "USE_LAZAX_GATE_FOLDING"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("winnu" as never) || !player.technologies.includes("lazax_gate_folding" as never)) {
    return { ok: false, error: "This player doesn't have Lazax Gate Folding." };
  }
  if (player.exhaustedTechnologies.includes("lazax_gate_folding" as never)) {
    return { ok: false, error: "Lazax Gate Folding is already exhausted." };
  }
  const mecatolSystemId = rules.mecatolSystemId as SystemId;
  const mecatolSystem = state.systems[mecatolSystemId];
  const mecatolPlanet = mecatolSystem?.planets.find((p) => rules.planets[p.planetId]?.isMecatolRex);
  const controlsMecatol = mecatolPlanet?.controllerId === action.playerId;

  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: { ...player, exhaustedTechnologies: [...player.exhaustedTechnologies, "lazax_gate_folding" as never] } } };
  if (controlsMecatol && mecatolPlanet) {
    const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.playerId, [{ unitType: "infantry", count: 1 }]);
    if (!reinforcementsCheck.ok) return reinforcementsCheck;
    const stacks = (mecatolPlanet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === "infantry" && !s.upgradeId);
    if (existing) existing.count += 1;
    else stacks.push({ unitType: "infantry", count: 1, damagedCount: 0 });
    const updatedPlanet: PlanetState = { ...mecatolPlanet, unitsByPlayer: { ...mecatolPlanet.unitsByPlayer, [action.playerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [mecatolSystemId]: { ...mecatolSystem!, planets: mecatolSystem!.planets.map((p) => (p.planetId === mecatolPlanet.planetId ? updatedPlanet : p)) } } };
  }
  return { ok: true, state: nextState, events: [] };
}

/**
 * Winnu "Hegemonic Trade Policy" (faction technology): "Exhaust this
 * card when 1 or more of your units use PRODUCTION; swap the resource
 * and influence values of 1 planet you control during that use of
 * Production." Confirmed (yjmrobert.com/tirules/factions/f_winnu):
 * "Changing a planet's resource value will affect the Production value
 * of a Space Dock on that planet" — i.e. this needs to apply BEFORE the
 * production-limit calculation, not just the cost payment, so it's
 * modeled as its own state-mutating step the caller resolves BEFORE
 * calling PRODUCE_UNITS (phases/production.ts's own executeProduction),
 * rather than a parameter threaded through that already-complex
 * function.
 */
export function useHegemonicTradePolicy(
  state: GameState,
  action: { type: "USE_HEGEMONIC_TRADE_POLICY"; playerId: PlayerId; planetId: PlanetId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("winnu" as never) || !player.technologies.includes("hegemonic_trade_policy" as never)) {
    return { ok: false, error: "This player doesn't have Hegemonic Trade Policy." };
  }
  if (player.exhaustedTechnologies.includes("hegemonic_trade_policy" as never)) {
    return { ok: false, error: "Hegemonic Trade Policy is already exhausted." };
  }
  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.planetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found || found.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player doesn't control that planet." };
  }
  void rules;
  const updatedPlanet: PlanetState = { ...found.planet, swappedResourceInfluence: !found.planet.swappedResourceInfluence };
  const updatedPlayer: Player = { ...player, exhaustedTechnologies: [...player.exhaustedTechnologies, "hegemonic_trade_policy" as never] };
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [action.playerId]: updatedPlayer },
      systems: { ...state.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) } },
    },
    events: [],
  };
}

/**
 * Winnu "Berekar Berekon" (agent): "When 1 or more of a player's units
 * use PRODUCTION: You may exhaust this card to reduce the combined cost
 * of the produced units by 2." Confirmed
 * (yjmrobert.com/tirules/factions/f_winnu): "Production limits still
 * apply" — this only discounts the COST (resources/trade goods needed),
 * never the quantity-produced limit, which phases/production.ts's own
 * executeProduction already enforces completely independently. Applies
 * to ANY player's production (Berekon's own text says "a player's",
 * not "your own"), matching the note above about Magmus's own
 * interaction.
 */
export function useBerekarBerekon(
  state: GameState,
  action: { type: "USE_BEREKAR_BEREKON"; playerId: PlayerId },
): ActionResult {
  const player = state.players[action.playerId];
  const winnuId = Object.values(state.players).find((p) => p.factionId === ("winnu" as never))?.id;
  if (!winnuId) return { ok: false, error: "No Winnu player in this game." };
  const winnuPlayer = state.players[winnuId];
  const agentEntry = winnuPlayer.leaders.find((l) => l.leaderId === ("winnu_agent" as never));
  if (!agentEntry || agentEntry.locked) return { ok: false, error: "Berekar Berekon isn't available." };
  if (agentEntry.exhausted) return { ok: false, error: "Berekar Berekon is already exhausted." };
  void player;

  const updatedWinnu: Player = { ...winnuPlayer, leaders: winnuPlayer.leaders.map((l) => (l.leaderId === ("winnu_agent" as never) ? { ...l, exhausted: true } : l)) };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [winnuId]: updatedWinnu }, pendingBerekarBerekonDiscount: action.playerId },
    events: [],
  };
}

/**
 * Winnu "Mathis Mathinus — Imperial Seal" (hero): "ACTION: Perform the
 * primary ability of any strategy card. Then, choose any number of
 * other players; those players may perform the secondary ability of
 * that strategy card." Confirmed
 * (yjmrobert.com/tirules/factions/f_winnu): "a player chosen must still
 * spend a command token from their strategy pool to do so, except for
 * Leadership (and potentially Trade)" and "if the Winnu player chose the
 * Trade card via the hero, it is OPTIONAL for the chosen player to
 * resolve the secondary" — matching the SAME normal secondary-cost
 * rules as any other secondary resolution, so this only marks the
 * primary as usable + grants the chosen players PERMISSION to resolve
 * that card's secondary this round even though it isn't the active
 * strategy card for anyone — the actual primary/secondary resolution
 * still goes through phases/strategyCardAbilities.ts's own existing
 * functions unmodified. "Acquiescence Ω cannot be triggered by this
 * ability" — confirmed by construction, since this never sets
 * pendingAcquiescenceOmegaFreeSecondary at all.
 */
export function useMathisMathinus(
  state: GameState,
  action: { type: "USE_MATHIS_MATHINUS"; playerId: PlayerId; strategyCardId: StrategyCardId; grantedPlayerIds: PlayerId[] },
): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "Mathis Mathinus is only usable during the action phase." };
  if (state.activePlayerId !== action.playerId) return { ok: false, error: "RR 4: it isn't this player's turn." };
  const player = state.players[action.playerId];
  const heroEntry = player?.leaders.find((l) => l.leaderId === ("winnu_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Mathis Mathinus." };

  const updatedPlayer = { ...player, leaders: player.leaders.filter((l) => l.leaderId !== ("winnu_hero" as never)) };
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [action.playerId]: updatedPlayer },
      pendingMathisMathinusGrant: { cardId: action.strategyCardId, playerIds: action.grantedPlayerIds },
    },
    events: [],
  };
}

/**
 * Winnu "Imperator" (Breakthrough ability), movement half: "After you
 * activate a system that contains a legendary planet, apply +1 to the
 * move value of 1 of your ships during this tactical action." The
 * combat-bonus half ("+1 per Support for the Throne in your opponent's
 * play area", confirmed applying even to Winnu's own note if it ended up
 * there) lives directly in rules/combat.ts's own buildSpaceCombatEntries/
 * buildGroundCombatEntries instead, computed inline from
 * promissoryNotesInPlayArea — no separate function needed for a flat,
 * always-on die modifier like that.
 */
export function activateSystemImperatorMoveBonus(state: GameState, playerId: PlayerId, systemId: SystemId, rules: RuleData): GameState {
  const player = state.players[playerId];
  if (!player || player.factionId !== ("winnu" as never) || !player.hasBreakthrough) return state;
  const system = state.systems[systemId];
  const hasLegendaryPlanet = system?.planets.some((p) => rules.planets[p.planetId]?.isLegendary) ?? false;
  if (!hasLegendaryPlanet || !state.pendingTacticalAction) return state;
  return { ...state, pendingTacticalAction: { ...state.pendingTacticalAction, imperatorMoveBonusSystemId: systemId } };
}
