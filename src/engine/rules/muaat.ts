import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId, asPlanetId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { getAdjacentSystems } from "./adjacency";
import { checkReinforcementsAvailable } from "./reinforcements";
import { findControlledLegendaryPlanet, exhaustLegendaryAbility } from "../phases/legendaryPlanets";
import { hasAbility } from "./abilities";
import { asAbilityId } from "../types/ids";
import { UnitType, GROUND_FORCE_TYPES } from "../types/enums";
import { getUnitStats } from "../types/RuleData";
import { spendForCost } from "../phases/technology";
import { hasCodex } from "./gameMode";

/**
 * Muaat "STAR FORGE" (base faction ability): "ACTION: Spend 1 token from
 * your strategy pool to place either 2 fighters or 1 destroyer from your
 * reinforcements in a system that contains 1 or more of your war suns."
 * Confirmed nowhere in this project until now — flagged during the same
 * pass that added The Nucleus (Avernus's own legendary ability, which
 * depends on this one existing to have anything to waive the cost of).
 */
export function useStarForge(
  state: GameState,
  action: { type: "USE_STAR_FORGE"; playerId: PlayerId; systemId: SystemId; choice: "fighters" | "destroyer" },
  rules: RuleData,
  /** Set by useTheNucleus below when Avernus's own legendary ability is waiving this cost — skips the strategy-token spend entirely, otherwise identical. */
  skipCost = false,
): ActionResult {
  const player = state.players[action.playerId];
  if (player.factionId !== ("muaat" as never)) return { ok: false, error: "Only the Muaat player has STAR FORGE." };
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const hasWarSun = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "war_sun" && s.count > 0);
  if (!hasWarSun) return { ok: false, error: "This player has no war sun in that system." };

  let updatedPlayer = player;
  if (!skipCost) {
    const { strategy } = player.commandTokens;
    if (strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };
    updatedPlayer = { ...updatedPlayer, commandTokens: { ...updatedPlayer.commandTokens, strategy: strategy - 1 } };
  }

  const unitType = action.choice === "destroyer" ? "destroyer" : "fighter";
  const count = action.choice === "destroyer" ? 1 : 2;
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType, count }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const stacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType && !s.upgradeId);
  const updatedStacks = existing ? stacks.map((s) => (s === existing ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType, count, damagedCount: 0 }];
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };

  const nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, systems: { ...state.systems, [action.systemId]: updatedSystem } };
  return { ok: true, state: nextState, events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, planetId: asPlanetId("avernus"), unitType, count, totalCost: 0 }] };
}

/**
 * Avernus / "The Nucleus" (Muaat's own legendary planet ability, gained
 * via their Breakthrough — Stellar Genesis, below): "ACTION: Exhaust
 * this card to use the Embers of Muaat's STAR FORGE faction ability
 * without spending a command token." A thin wrapper around useStarForge
 * with skipCost=true — exhausts Avernus's own ability card (via the
 * shared legendaryPlanets.ts helpers) instead of the strategy pool.
 */
export function useTheNucleus(
  state: GameState,
  action: { type: "USE_THE_NUCLEUS"; playerId: PlayerId; systemId: SystemId; choice: "fighters" | "destroyer" },
  rules: RuleData,
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("avernus"));
  if ("error" in found) return { ok: false, error: found.error };

  const result = useStarForge(state, { type: "USE_STAR_FORGE", playerId: action.playerId, systemId: action.systemId, choice: action.choice }, rules, true);
  if (!result.ok) return result;

  const nextState = exhaustLegendaryAbility(result.state, found.systemId, asPlanetId("avernus"));
  return { ok: true, state: nextState, events: result.events };
}

/**
 * Muaat "Stellar Genesis" (Breakthrough ability): "When you gain this
 * card, place the Avernus planet token into a non-home system that is
 * adjacent to a planet you control; gain control of and ready it."
 * Confirmed explicit exception to the normal "gained control = exhausted"
 * rule — Avernus starts READIED, not exhausted, the moment it's placed.
 * "After you move 1 of your war suns out of or through Avernus's system
 * and into a non-home system, you may move the Avernus token with it" —
 * that relocation half is a KNOWN GAP not built in this pass (moving a
 * PLANET together with a ship mid-movement is a genuinely novel
 * mechanic this project has no equivalent scaffolding for yet; flagged
 * rather than silently half-implemented).
 */
export function applyStellarGenesisOnGain(state: GameState, playerId: PlayerId, targetSystemId: SystemId, rules: RuleData): { ok: true; state: GameState; events: GameEvent[] } | { ok: false; error: string } {
  const system = state.systems[targetSystemId];
  if (!system) return { ok: false, error: `No system ${targetSystemId}.` };
  if (rules.homeSystemByFaction[state.players[playerId]?.factionId] === targetSystemId) {
    return { ok: false, error: 'Muaat "Stellar Genesis": Avernus cannot be placed in a home system.' };
  }
  const isAdjacentToControlledPlanet = Object.entries(state.systems).some(
    ([sysId, sys]) => sys.planets.some((p) => p.controllerId === playerId) && [sysId, ...getAdjacentSystems(state, sysId as SystemId, rules)].includes(targetSystemId),
  );
  if (!isAdjacentToControlledPlanet) {
    return { ok: false, error: 'Muaat "Stellar Genesis": target system must be adjacent to a planet this player controls.' };
  }

  const avernusPlanet: PlanetState = {
    planetId: asPlanetId("avernus"),
    controllerId: playerId,
    exhausted: false, // confirmed exception — gained READIED, not exhausted
    legendaryAbilityExhausted: false,
    explored: true, // it's a fixed legendary planet with a printed ability card, not something drawn from an exploration deck
    attachmentIds: [],
    unitsByPlayer: {},
  };
  const updatedSystem: SystemState = { ...system, planets: [...system.planets, avernusPlanet] };
  const nextState: GameState = { ...state, systems: { ...state.systems, [targetSystemId]: updatedSystem } };
  return { ok: true, state: nextState, events: [{ type: "PLANET_CONTROL_ESTABLISHED", systemId: targetSystemId, planetId: asPlanetId("avernus"), playerId }] };
}

/**
 * Embers of Muaat "GASHLAI PHYSIOLOGY" (faction ability) / "Magmus
 * Reactor" (either version — both original and Ω grant this same
 * movement exception): "Your ships can move [through/into] supernovas."
 * No additional confirmed rulings beyond the printed text — a passive
 * movement-anomaly exception, threaded into rules/movement.ts's own
 * canShipReachSystem (its own techs.canMoveThroughSupernova) alongside
 * the existing Antimass Deflectors/Nav Suite/Circlet of the Void
 * carve-outs.
 */
export function canMoveThroughSupernova(player: Player): boolean {
  return hasAbility(player, asAbilityId("gashlai_physiology")) || player.technologies.includes("magmus_reactor" as never);
}

/**
 * Embers of Muaat "Magmus Reactor Ω" (faction tech, Codex version):
 * "Your ships can move into supernovas. Each supernova that contains 1
 * or more of your units gains the PRODUCTION 5 ability as if it were 1
 * of your units." Confirmed
 * (yjmrobert.com/tirules/factions/f_muaat — see this file's own
 * canMoveThroughSupernova for the shared movement half, and
 * phases/elimination.ts's own meetsEliminationConditions for the "can't
 * be eliminated" half). Modeled as a SEPARATE, system-based production
 * action (no planet involved at all, since supernovas have none) — same
 * shape as Arborec's own Duha Menaimon flagship production
 * (rules/arborec.ts's own useDuhaMenaimonProduction), just capped at 5
 * instead of that one's own 5-unit cap coincidentally matching.
 */
export function useMagmusReactorOmegaProduction(
  state: GameState,
  action: { type: "USE_MAGMUS_REACTOR_OMEGA_PRODUCTION"; playerId: PlayerId; systemId: SystemId; units: { unitType: UnitType; count: number }[]; exhaustPlanetIdsForResources: PlanetId[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("magmus_reactor" as never) || !hasCodex(state.mode)) {
    return { ok: false, error: "This player doesn't have Magmus Reactor Ω." };
  }
  const system = state.systems[action.systemId];
  if (!system?.anomalies?.includes("supernova" as never)) return { ok: false, error: "That system isn't a supernova." };
  if (!(system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0)) {
    return { ok: false, error: "This player has no units of their own in that supernova." };
  }

  const totalRequested = action.units.reduce((sum, u) => sum + u.count, 0);
  if (totalRequested <= 0) return { ok: false, error: "No units specified." };
  if (totalRequested > 5) return { ok: false, error: "Magmus Reactor Ω: can produce at most 5 units total." };

  const hasEnemyShips = Object.entries(system.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0));
  if (hasEnemyShips && action.units.some((u) => u.count > 0 && u.unitType !== "infantry" && u.unitType !== "mech")) {
    return { ok: false, error: "A ship may only be produced here if no other player currently has ships in this system." };
  }

  let totalCost = 0;
  const resolvedUnits: { unitType: UnitType; count: number }[] = [];
  for (const { unitType, count } of action.units) {
    if (count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats || stats.cost == null) return { ok: false, error: `${unitType} has no cost and cannot be produced this way.` };
    const perToken = stats.producesQuantity ?? 1;
    if (count % perToken !== 0) return { ok: false, error: `${unitType} is produced ${perToken} at a time.` };
    totalCost += (count / perToken) * stats.cost;
    resolvedUnits.push({ unitType, count });
  }

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, resolvedUnits);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const spend = spendForCost(state, action.playerId, totalCost, action.exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  let nextState = spend.state;
  const events: GameEvent[] = [];
  const updatedSpaceStacks = (nextState.systems[action.systemId]?.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  for (const { unitType, count } of resolvedUnits) {
    const existing = updatedSpaceStacks.find((s) => s.unitType === unitType);
    if (existing) existing.count += count;
    else updatedSpaceStacks.push({ unitType, count, damagedCount: 0 });
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, unitType, count, totalCost: 0 });
  }
  nextState = { ...nextState, systems: { ...nextState.systems, [action.systemId]: { ...nextState.systems[action.systemId], spaceUnitsByPlayer: { ...nextState.systems[action.systemId].spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks } } } };

  return { ok: true, state: nextState, events };
}

function findMuaatPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("muaat" as never))?.id;
}

/**
 * Embers of Muaat "Fires of the Gashlai" (promissory note): "ACTION:
 * Remove 1 token from the Muaat player's fleet pool and return it to
 * their reinforcements. Then, gain your war sun unit upgrade technology
 * card. Then, return this card to the Muaat player." Confirmed
 * (yjmrobert.com/tirules/factions/f_muaat): "if a player already owns
 * their war sun unit upgrade technology, they cannot play Fires of the
 * Gashlai."
 */
export function useFiresOfTheGashlai(state: GameState, action: { type: "USE_FIRES_OF_THE_GASHLAI"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("muaat_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Fires of the Gashlai in hand." };
  }
  if (player.technologies.includes("war_sun" as never)) {
    return { ok: false, error: "This player already owns War Sun technology — Fires of the Gashlai cannot be played." };
  }
  const muaatPlayerId = findMuaatPlayerId(state);
  if (!muaatPlayerId) return { ok: false, error: "No Embers of Muaat player in this game." };
  if (player.commandTokens.fleet <= 0) return { ok: false, error: "No command token in this player's fleet pool to remove." };

  const muaatPlayer = state.players[muaatPlayerId];
  const updatedPlayer: Player = {
    ...player,
    commandTokens: { ...player.commandTokens, fleet: player.commandTokens.fleet - 1 },
    technologies: [...player.technologies, "war_sun" as never],
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("muaat_promissory" as never)),
  };
  const updatedMuaatPlayer: Player = { ...muaatPlayer, promissoryNotesInHand: [...muaatPlayer.promissoryNotesInHand, "muaat_promissory" as never] };

  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [muaatPlayerId]: updatedMuaatPlayer } },
    events: [],
  };
}

/**
 * Embers of Muaat "The Inferno" (flagship, Forge Cruiser): "ACTION:
 * Spend 1 token from your strategy pool to place 1 cruiser in this
 * unit's system." No additional confirmed rulings beyond the printed
 * text.
 */
export function useForgeCruiser(state: GameState, action: { type: "USE_FORGE_CRUISER"; playerId: PlayerId; systemId: SystemId } ): ActionResult {
  const player = state.players[action.playerId];
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };

  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (!(system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "flagship" && s.count > 0)) {
    return { ok: false, error: "Forge Cruiser: The Inferno must be in that system." };
  }

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "cruiser", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const stacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "cruiser");
  const updatedStacks = existing ? stacks.map((s) => (s.unitType === "cruiser" ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "cruiser" as const, count: 1, damagedCount: 0 }];
  const updatedPlayer: Player = { ...player, commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 } };

  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [action.systemId]: { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } } }, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, unitType: "cruiser", count: 1, totalCost: 0 }],
  };
}

/**
 * Embers of Muaat "Ember Colossus" (mech, Star Forge Spawn): "When you
 * use your STAR FORGE faction ability in this system or an adjacent
 * system, you may place 1 infantry from your reinforcements with this
 * unit." No additional confirmed rulings beyond the printed text —
 * modeled as a separate, optional follow-up action the caller submits
 * right after useStarForge, rather than folded into that function
 * automatically (matching this project's own "reactive trigger,
 * trusted timing" convention elsewhere).
 */
export function useEmberColossusSpawn(
  state: GameState,
  action: { type: "USE_EMBER_COLOSSUS_SPAWN"; playerId: PlayerId; emberColossusSystemId: SystemId; starForgeSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const targetSystem = state.systems[action.emberColossusSystemId];
  if (!targetSystem) return { ok: false, error: `No system ${action.emberColossusSystemId}.` };
  const mechPlanet = targetSystem.planets.find((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0));
  const mechInSpace = (targetSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0);
  if (!mechPlanet && !mechInSpace) return { ok: false, error: "This player has no Ember Colossus in that system." };

  const isSameOrAdjacent = action.emberColossusSystemId === action.starForgeSystemId || getAdjacentSystems(state, action.emberColossusSystemId, rules).includes(action.starForgeSystemId);
  if (!isSameOrAdjacent) return { ok: false, error: "Star Forge Spawn: the Star Forge use must be in this system or an adjacent one." };

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "infantry", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  if (mechPlanet) {
    const stacks = mechPlanet.unitsByPlayer[action.playerId] ?? [];
    const existing = stacks.find((s) => s.unitType === "infantry");
    const updatedStacks = existing ? stacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "infantry" as const, count: 1, damagedCount: 0 }];
    const updatedPlanet: PlanetState = { ...mechPlanet, unitsByPlayer: { ...mechPlanet.unitsByPlayer, [action.playerId]: updatedStacks } };
    const updatedSystem: SystemState = { ...targetSystem, planets: targetSystem.planets.map((p) => (p.planetId === mechPlanet.planetId ? updatedPlanet : p)) };
    return { ok: true, state: { ...state, systems: { ...state.systems, [action.emberColossusSystemId]: updatedSystem } }, events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.emberColossusSystemId, planetId: mechPlanet.planetId, unitType: "infantry", count: 1, totalCost: 0 }] };
  }

  const spaceStacks = targetSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  const existingSpace = spaceStacks.find((s) => s.unitType === "infantry");
  const updatedSpaceStacks = existingSpace ? spaceStacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + 1 } : s)) : [...spaceStacks, { unitType: "infantry" as const, count: 1, damagedCount: 0 }];
  const updatedSystem: SystemState = { ...targetSystem, spaceUnitsByPlayer: { ...targetSystem.spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks } };
  return { ok: true, state: { ...state, systems: { ...state.systems, [action.emberColossusSystemId]: updatedSystem } }, events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.emberColossusSystemId, unitType: "infantry", count: 1, totalCost: 0 }] };
}

/**
 * Embers of Muaat "Umbat" (agent): "ACTION: Exhaust this card to choose
 * a player; that player may produce up to 2 units that each have a
 * cost of 4 or less in a system that contains one of their war suns or
 * their flagship." Confirmed (yjmrobert.com/tirules/factions/f_muaat):
 *  - The produced units must be paid for.
 *  - No Production ability is used — Sarween Tools and similar
 *    cost-reduction effects don't apply (no such logic invoked here at
 *    all, a pure direct payment).
 *  - Ground forces may be placed in the space area OR on a planet this
 *    player controls in that system.
 *  - If the Naalu or Yin players are chosen and choose to produce
 *    fighters/infantry, they can only produce 2 total — their own
 *    commander's own "extra unit" bonus has no effect here — UNLESS
 *    the Regulated Conscription law is in play, in which case their
 *    commander DOES apply (2-for-1 fighters/infantry, not counted
 *    against the 2-unit cap here). KNOWN SCOPE LIMIT: the Regulated
 *    Conscription interaction specifically isn't modeled here — this
 *    function enforces a flat "at most 2 units" cap regardless of that
 *    law; flagged rather than silently assumed correct.
 *  - This is the AGENT-BENEFITS-ANOTHER-PLAYER pattern — ownerId
 *    (whoever holds Umbat) separate from targetPlayerId (whoever
 *    actually produces).
 */
export function useUmbat(
  state: GameState,
  action: { type: "USE_UMBAT"; ownerId: PlayerId; targetPlayerId: PlayerId; systemId: SystemId; units: { unitType: UnitType; count: number }[]; exhaustPlanetIdsForResources: PlanetId[]; groundForceTargetPlanetId?: PlanetId },
  rules: RuleData,
): ActionResult {
  const owner = state.players[action.ownerId];
  const agentEntry = owner.leaders.find((l) => l.leaderId === ("muaat_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have Umbat." };
  if (agentEntry.exhausted) return { ok: false, error: "Umbat is already exhausted." };

  const target = state.players[action.targetPlayerId];
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const hasWarSunOrFlagship = (system.spaceUnitsByPlayer[action.targetPlayerId] ?? []).some((s) => (s.unitType === "war_sun" || s.unitType === "flagship") && s.count > 0);
  if (!hasWarSunOrFlagship) return { ok: false, error: "Umbat: that system must contain that player's own war sun or flagship." };

  const totalRequested = action.units.reduce((sum, u) => sum + u.count, 0);
  if (totalRequested <= 0) return { ok: false, error: "No units specified." };
  if (totalRequested > 2) return { ok: false, error: "Umbat: can produce at most 2 units total." };

  let totalCost = 0;
  const resolvedUnits: { unitType: UnitType; count: number }[] = [];
  for (const { unitType, count } of action.units) {
    if (count <= 0) continue;
    const stats = getUnitStats(rules, target.factionId, unitType, target.unitUpgrades);
    if (!stats || stats.cost == null) return { ok: false, error: `${unitType} has no cost and cannot be produced this way.` };
    if (stats.cost > 4) return { ok: false, error: `Umbat: ${unitType} costs more than 4.` };
    const perToken = stats.producesQuantity ?? 1;
    if (count % perToken !== 0) return { ok: false, error: `${unitType} is produced ${perToken} at a time.` };
    totalCost += (count / perToken) * stats.cost;
    resolvedUnits.push({ unitType, count });
  }

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.targetPlayerId, resolvedUnits);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const spend = spendForCost(state, action.targetPlayerId, totalCost, action.exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  let nextState = spend.state;
  const events: GameEvent[] = [];
  let updatedSpaceStacks = (nextState.systems[action.systemId]?.spaceUnitsByPlayer[action.targetPlayerId] ?? []).map((s) => ({ ...s }));
  let groundForceTargetPlanet: PlanetState | undefined;
  if (action.groundForceTargetPlanetId) {
    groundForceTargetPlanet = nextState.systems[action.systemId]?.planets.find((p) => p.planetId === action.groundForceTargetPlanetId);
    if (!groundForceTargetPlanet || groundForceTargetPlanet.controllerId !== action.targetPlayerId) {
      return { ok: false, error: "That player doesn't control that planet in this system." };
    }
  }
  for (const { unitType, count } of resolvedUnits) {
    const isGroundForce = GROUND_FORCE_TYPES.includes(unitType);
    if (isGroundForce && groundForceTargetPlanet) {
      const stacks = groundForceTargetPlanet.unitsByPlayer[action.targetPlayerId] ?? [];
      const existing = stacks.find((s) => s.unitType === unitType);
      const updatedStacks = existing ? stacks.map((s) => (s.unitType === unitType ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType, count, damagedCount: 0 }];
      groundForceTargetPlanet = { ...groundForceTargetPlanet, unitsByPlayer: { ...groundForceTargetPlanet.unitsByPlayer, [action.targetPlayerId]: updatedStacks } };
    } else {
      const existing = updatedSpaceStacks.find((s) => s.unitType === unitType);
      if (existing) existing.count += count;
      else updatedSpaceStacks.push({ unitType, count, damagedCount: 0 });
    }
    events.push({ type: "UNITS_PRODUCED", playerId: action.targetPlayerId, systemId: action.systemId, unitType, count, totalCost: 0 });
  }
  const systemAfterSpace = { ...nextState.systems[action.systemId], spaceUnitsByPlayer: { ...nextState.systems[action.systemId].spaceUnitsByPlayer, [action.targetPlayerId]: updatedSpaceStacks } };
  const updatedSystem: SystemState = groundForceTargetPlanet
    ? { ...systemAfterSpace, planets: systemAfterSpace.planets.map((p) => (p.planetId === groundForceTargetPlanet!.planetId ? groundForceTargetPlanet! : p)) }
    : systemAfterSpace;
  nextState = { ...nextState, systems: { ...nextState.systems, [action.systemId]: updatedSystem } };

  nextState = { ...nextState, players: { ...nextState.players, [action.ownerId]: { ...nextState.players[action.ownerId], leaders: nextState.players[action.ownerId].leaders.map((l) => (l.leaderId === ("muaat_agent" as never) ? { ...l, exhausted: true } : l)) } } };

  return { ok: true, state: nextState, events };
}

/**
 * Embers of Muaat "Magmus" (commander): "After you spend a token from
 * your strategy pool: You may gain 1 trade good." Confirmed
 * (yjmrobert.com/tirules/factions/f_muaat):
 *  - When spending to resolve a strategy card's secondary, the trade
 *    good is gained AFTER resolving the secondary — cannot be spent to
 *    pay for the secondary's own cost.
 *  - Spending multiple tokens (e.g. Lead From the Front) grants that
 *    many trade goods, one at a time (each may separately trigger
 *    Mentak's own Pillage).
 *  - Must have Magmus ALREADY unlocked BEFORE spending the token — not
 *    retroactive (e.g. spending a token to resolve Warfare's own
 *    secondary, thereby producing the war sun that unlocks Magmus,
 *    does NOT retroactively grant the trade good for THAT SAME spend).
 */
export function useMagmusTradeGood(state: GameState, action: { type: "USE_MAGMUS_TRADE_GOOD"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("muaat_commander" as never));
  if (!commanderEntry || commanderEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Magmus." };

  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: { ...player, tradeGoods: player.tradeGoods + 1 } } }, events: [] };
}

/**
 * Embers of Muaat "Adjudicator Ba'al — NOVA SEED" (hero, single-use):
 * "After you move a war sun into a non-home system other than Mecatol
 * Rex: You may destroy all other players' units in that system and
 * replace that system tile with the Muaat supernova tile. If you do,
 * purge this card and each planet card that corresponds to the
 * replaced system tile." Confirmed
 * (yjmrobert.com/tirules/factions/f_muaat):
 *  - ANY method of movement triggers this, not only tactical-action
 *    movement (e.g. a retreat) — Mahact's own Benediction moving this
 *    player's war sun does NOT count. KNOWN SIMPLIFICATION: this
 *    project has no single unified "a war sun of mine just moved here,
 *    by any method" event to hook into generically — the caller is
 *    trusted to submit this action right after any qualifying move,
 *    same "trusted timing" convention as elsewhere.
 *  - If the war sun was ALREADY in the target system when it was
 *    activated, it must move OUT and back IN for this to trigger — not
 *    separately validated here (folded into the same trusted-timing
 *    simplification above).
 *  - Command tokens, frontier tokens, and this player's OWN units on
 *    the replaced tile transfer to the new supernova tile; Creuss
 *    wormhole tokens return to the Creuss player (not modeled — Creuss
 *    isn't implemented in this project yet, nothing to return); Ul
 *    sleeper tokens return to the Ul player (same — not implemented);
 *    all OTHER tokens are purged. Achieved mostly "for free" since the
 *    SystemId itself doesn't change (only its own anomalies/planets),
 *    so command tokens and the frontier token flag are untouched here.
 *  - This player's own units may exist in and move out of the
 *    supernova system even without Magmus Reactor — achieved for free,
 *    since nothing here checks tech ownership for THAT (only actual
 *    fresh MOVEMENT into a supernova needs canMoveThroughSupernova,
 *    which is a separate, already-resolved concern by the time this
 *    runs).
 *  - If this player owns Magmus Reactor Ω and resolves this during a
 *    tactical action, they can produce during the Production step if
 *    they still have units in the system — no special handling needed
 *    here, since useMagmusReactorOmegaProduction above already checks
 *    "is this a supernova with my own units" fresh, regardless of how
 *    recently it became one.
 *  - Cannot target an eliminated player's home system, or Mecatol Rex.
 *  - CAN target the Creuss Gate or the Wormhole Nexus.
 */
export function useNovaSeed(state: GameState, action: { type: "USE_NOVA_SEED"; playerId: PlayerId; systemId: SystemId }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("muaat_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Adjudicator Ba'al." };

  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (Object.values(rules.homeSystemByFaction).includes(action.systemId)) {
    return { ok: false, error: "NOVA SEED cannot target a home system." };
  }
  if (rules.mecatolSystemId === action.systemId) {
    return { ok: false, error: "NOVA SEED cannot target the Mecatol Rex system." };
  }
  if (!(system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "war_sun" && s.count > 0)) {
    return { ok: false, error: "NOVA SEED: this player must have a war sun in that system." };
  }

  // Destroy all other players' units in the system — ships, and ground forces/structures on every planet there.
  const spaceUnitsByPlayer: SystemState["spaceUnitsByPlayer"] = { [action.playerId]: system.spaceUnitsByPlayer[action.playerId] ?? [] };

  // Purge every planet on the replaced tile — "purge each planet card that corresponds to the replaced system tile" — removed from the game entirely, not just uncontrolled.
  const updatedSystem: SystemState = {
    ...system,
    anomalies: ["supernova" as never],
    planets: [],
    spaceUnitsByPlayer,
  };

  const updatedPlayer: Player = { ...player, leaders: player.leaders.filter((l) => l.leaderId !== ("muaat_hero" as never)) };
  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [action.systemId]: updatedSystem }, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [],
  };
}
