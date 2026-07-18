import { GameState, Player, PlanetState, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asTechId } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getEffectivePlanetStats } from "../rules/planetStats";
import { hasPoKContent } from "../rules/gameMode";
import { applyExplorationCard } from "./exploration";
import { advanceActivePlayer } from "./actionPhase";
import { executeProduction } from "./production";

/**
 * RR "Technology" — the standalone abilities of 6 exhaustable/passive
 * techs that don't fit the tactical-action-step handlers elsewhere (see
 * this project's own note on which techs live where): each is its own
 * GameAction rather than a modifier threaded through an existing one,
 * since none of them share a natural existing action to piggyback on the
 * way Gravity Drive rides MOVE_SHIPS or AI Development Algorithm rides
 * RESEARCH_UNIT_UPGRADE.
 *
 * Timing simplification, flagged rather than silently strict: several of
 * these (Self-Assembly Routines, Sling Relay, Integrated Economy, Dacxive
 * Animators) are printed as "after you do X" — this engine doesn't have a
 * generic "was X the most recent thing that happened" gate for arbitrary
 * production/exploration triggers the way it does for combat-adjacent
 * events (state.recentEvents), so the boundedness comes from checking
 * CURRENT state (e.g. "does this player control a planet with a mech on
 * it") rather than strictly proving it just happened THIS instant. Dacxive
 * Animators and Integrated Economy specifically DO check recentEvents
 * (ground combat win / control gained, both already tracked there), so
 * those two are timing-accurate; the others are a reasonable, bounded
 * approximation.
 */

function ownsReadiedTech(player: Player, techId: string): { ok: true } | { ok: false; error: string } {
  const id = asTechId(techId);
  if (!player.technologies.includes(id)) return { ok: false, error: `This player doesn't own ${techId}.` };
  if (player.exhaustedTechnologies.includes(id)) return { ok: false, error: `${techId} is already exhausted.` };
  return { ok: true };
}

function exhaustTech(player: Player, techId: string): Player {
  return { ...player, exhaustedTechnologies: [...player.exhaustedTechnologies, asTechId(techId)] };
}

function findPlanet(state: GameState, planetId: PlanetId): { systemId: SystemId; system: SystemState; planet: PlanetState } | null {
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === planetId);
    if (planet) return { systemId: systemId as SystemId, system, planet };
  }
  return null;
}

/** RR "Self-Assembly Routines": exhaust to produce 1 free mech on a planet where this player already has at least 1 mech (a bounded proxy for "just produced one there" — see this file's own note on the timing simplification). */
export function useSelfAssemblyRoutines(
  state: GameState,
  action: { type: "USE_SELF_ASSEMBLY_ROUTINES"; playerId: PlayerId; planetId: PlanetId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  const techCheck = ownsReadiedTech(player, "self_assembly_routines");
  if (!techCheck.ok) return techCheck;

  const found = findPlanet(state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  const { systemId, system, planet } = found;
  if (planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  const mechStack = (planet.unitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "mech" && s.count > 0);
  if (!mechStack) return { ok: false, error: "This player has no mech on that planet." };

  const updatedStacks = (planet.unitsByPlayer[action.playerId] ?? []).map((s) =>
    s.unitType === "mech" ? { ...s, count: s.count + 1 } : s,
  );
  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: updatedStacks } };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    players: { ...state.players, [action.playerId]: exhaustTech(player, "self_assembly_routines") },
  };
  return {
    ok: true,
    state: nextState,
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId, planetId: action.planetId, unitType: "mech", count: 1, totalCost: 0 }],
  };
}

/** RR "Dacxive Animators": after winning a ground combat there this tactical action, may place 1 free infantry on that planet. Not exhaustable — repeatable every time it triggers. */
export function useDacxiveAnimators(
  state: GameState,
  action: { type: "USE_DACXIVE_ANIMATORS"; playerId: PlayerId; planetId: PlanetId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.technologies.includes(asTechId("dacxive_animators"))) {
    return { ok: false, error: "This player doesn't own Dacxive Animators." };
  }

  const found = findPlanet(state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  const { systemId, system, planet } = found;

  const wonGroundCombatHere = (state.recentEvents ?? []).some(
    (e) => e.type === "GROUND_COMBAT_ENDED" && e.planetId === action.planetId && e.survivingPlayerId === action.playerId,
  );
  if (!wonGroundCombatHere) {
    return { ok: false, error: "This player hasn't won a ground combat on that planet this tactical action." };
  }

  const stacks = planet.unitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "infantry");
  const updatedStacks = existing
    ? stacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + 1 } : s))
    : [...stacks, { unitType: "infantry" as UnitType, count: 1, damagedCount: 0 }];

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: updatedStacks } };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };

  const nextState: GameState = { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
  return {
    ok: true,
    state: nextState,
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId, planetId: action.planetId, unitType: "infantry", count: 1, totalCost: 0 }],
  };
}

/** RR "Integrated Economy": after gaining control of a planet this tactical action, may produce (for free) any units on it costing up to its resource value combined. Not exhaustable. */
export function useIntegratedEconomy(
  state: GameState,
  action: { type: "USE_INTEGRATED_ECONOMY"; playerId: PlayerId; planetId: PlanetId; units: { unitType: UnitType; count: number }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.technologies.includes(asTechId("integrated_economy"))) {
    return { ok: false, error: "This player doesn't own Integrated Economy." };
  }

  const found = findPlanet(state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  const { systemId, system, planet } = found;
  if (planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };

  const gainedControlHere = (state.recentEvents ?? []).some(
    (e) => e.type === "PLANET_CONTROL_ESTABLISHED" && e.planetId === action.planetId && e.playerId === action.playerId,
  );
  if (!gainedControlHere) {
    return { ok: false, error: "This player hasn't gained control of that planet this tactical action." };
  }

  let totalCost = 0;
  const resolved: { unitType: UnitType; count: number }[] = [];
  for (const { unitType, count } of action.units) {
    if (count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats) return { ok: false, error: `No stats for ${unitType}.` };
    const perToken = stats.producesQuantity ?? 1;
    if (count % perToken !== 0) {
      return { ok: false, error: `RR 58: ${unitType} is produced ${perToken} at a time — ${count} isn't a multiple of that.` };
    }
    totalCost += (count / perToken) * stats.cost;
    resolved.push({ unitType, count });
  }

  const resourceLimit = getEffectivePlanetStats(planet, action.planetId, rules).resources;
  if (totalCost > resourceLimit) {
    return { ok: false, error: `RR "Integrated Economy": total cost ${totalCost} exceeds ${action.planetId}'s resource value (${resourceLimit}).` };
  }

  const events: GameEvent[] = [];
  let updatedPlanetStacks = (planet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  let updatedSpaceStacks = (system.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  for (const { unitType, count } of resolved) {
    const isShip = unitType !== "infantry" && unitType !== "mech" && unitType !== "pds" && unitType !== "space_dock";
    const target = isShip ? updatedSpaceStacks : updatedPlanetStacks;
    const existing = target.find((s) => s.unitType === unitType && !s.upgradeId);
    if (existing) existing.count += count;
    else target.push({ unitType, count, damagedCount: 0 });
    if (isShip) updatedSpaceStacks = target;
    else updatedPlanetStacks = target;
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId, planetId: action.planetId, unitType, count, totalCost: 0 });
  }

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: updatedPlanetStacks } };
  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks },
    planets: system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)),
  };

  const nextState: GameState = { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
  return { ok: true, state: nextState, events };
}

/** RR "X-89 Bacterial Weapon": a component action (uses this player's whole turn, same as PASS/a tactical/strategic action) — exhaust, pick a planet in a system where this player has a Bombardment-capable ship, destroy every OTHER player's infantry there. */
export function useX89BacterialWeapon(
  state: GameState,
  action: { type: "USE_X89_BACTERIAL_WEAPON"; playerId: PlayerId; targetPlanetId: PlanetId },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "RR: this component action only applies during the action phase." };
  if (state.activePlayerId !== action.playerId) return { ok: false, error: "RR 4: it is not this player's turn." };
  if (state.pendingTacticalAction) return { ok: false, error: "Cannot use this with a tactical action in progress." };

  const player = state.players[action.playerId];
  const techCheck = ownsReadiedTech(player, "x89_bacterial_weapon");
  if (!techCheck.ok) return techCheck;

  const found = findPlanet(state, action.targetPlanetId);
  if (!found) return { ok: false, error: `No planet ${action.targetPlanetId}.` };
  const { systemId, system, planet } = found;

  const hasBombardmentShipHere = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => {
    if (s.count <= 0) return false;
    const stats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return Boolean(stats?.abilityValues?.bombardment);
  });
  if (!hasBombardmentShipHere) {
    return { ok: false, error: "This player has no Bombardment-capable ship in that system." };
  }

  const events: GameEvent[] = [];
  const updatedUnitsByPlayer: PlanetState["unitsByPlayer"] = {};
  for (const [pid, stacks] of Object.entries(planet.unitsByPlayer)) {
    if (pid === action.playerId) {
      updatedUnitsByPlayer[pid as PlayerId] = stacks;
      continue;
    }
    const infantryStack = (stacks ?? []).find((s) => s.unitType === "infantry" && s.count > 0);
    if (infantryStack) {
      events.push({ type: "UNITS_DESTROYED", playerId: pid as PlayerId, systemId, planetId: action.targetPlanetId, unitType: "infantry", count: infantryStack.count });
    }
    const remaining = (stacks ?? []).filter((s) => s.unitType !== "infantry");
    updatedUnitsByPlayer[pid as PlayerId] = remaining;
  }

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: updatedUnitsByPlayer };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) };

  const updatedPlayer = exhaustTech(player, "x89_bacterial_weapon");
  let nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    players: { ...state.players, [action.playerId]: updatedPlayer },
  };
  // RR: this is a component ACTION — it uses this player's entire turn,
  // same as PASS or finishing a tactical/strategic action, so initiative
  // advances to the next player exactly like those do.
  nextState = advanceActivePlayer(nextState);
  return { ok: true, state: nextState, events };
}

/** RR "Psychoarchaeology": during the action phase, exhaust a controlled planet with a tech specialty to gain 1 trade good. Exhausts the PLANET, not this tech (the tech's own card doesn't need exhausting for this half of its text — see this file's own header note). */
export function usePsychoarchaeology(
  state: GameState,
  action: { type: "USE_PSYCHOARCHAEOLOGY"; playerId: PlayerId; planetId: PlanetId },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "RR: this ability only applies during the action phase." };
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.technologies.includes(asTechId("psychoarchaeology"))) {
    return { ok: false, error: "This player doesn't own Psychoarchaeology." };
  }

  const found = findPlanet(state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  const { systemId, system, planet } = found;
  if (planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  if (planet.exhausted) return { ok: false, error: "That planet is already exhausted." };
  if ((rules.planets[action.planetId]?.techSpecialties ?? []).length === 0) {
    return { ok: false, error: "That planet has no technology specialty." };
  }

  const updatedPlanet: PlanetState = { ...planet, exhausted: true };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const updatedPlayer: Player = { ...player, tradeGoods: player.tradeGoods + 1 };

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    players: { ...state.players, [action.playerId]: updatedPlayer },
  };
  return { ok: true, state: nextState, events: [] };
}

/** RR "Scanlink Drone Network": when activating a system, explore 1 planet there that has this player's own units on it — independent of RR 35's normal "just gained control" trigger, and independent of whether it's already been explored. Not exhaustable — repeatable every tactical action. */
export function useScanlinkDroneNetwork(
  state: GameState,
  action: { type: "USE_SCANLINK_DRONE_NETWORK"; playerId: PlayerId; planetId: PlanetId },
  rules: RuleData,
): ActionResult {
  if (!hasPoKContent(state.mode)) {
    return {
      ok: false,
      error: "RR 35: Exploration is a Prophecy of Kings mechanic, not available without Prophecy of Kings + Codex content (base-only or Thunder's-Edge-only games).",
    };
  }
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.technologies.includes(asTechId("scanlink_drone_network"))) {
    return { ok: false, error: "This player doesn't own Scanlink Drone Network." };
  }

  const found = findPlanet(state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  const { systemId, planet } = found;
  const hasUnitsHere = (planet.unitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  if (!hasUnitsHere) return { ok: false, error: "This player has no units on that planet." };

  const planetData = rules.planets[action.planetId];
  const trait = planetData?.traits[0] as "cultural" | "industrial" | "hazardous" | undefined;
  if (!trait) return { ok: false, error: `RR 35: ${action.planetId} has no trait and can't be explored.` };

  const deck = state.explorationDecks?.[trait] ?? [];
  let nextState: GameState = state;
  const events: GameEvent[] = [];

  if (deck.length > 0) {
    const [cardId, ...rest] = deck;
    const result = applyExplorationCard(nextState, action.playerId, systemId, action.planetId, cardId, rules);
    nextState = result.state;
    events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: trait });
    nextState = { ...nextState, explorationDecks: { ...nextState.explorationDecks!, [trait]: rest } };
  }

  nextState = setExplored(nextState, systemId, action.planetId);
  return { ok: true, state: nextState, events };
}

/** RR "Sling Relay": a component action (uses this player's whole turn, same as X-89 Bacterial Weapon) — exhaust, produce 1 ship in ANY system containing 1 of this player's space docks, paying its normal cost against that dock's own Production limit (same mechanics as PRODUCE_UNITS/executeProduction — this just isn't restricted to the player's currently-activated system). */
export function useSlingRelay(
  state: GameState,
  action: { type: "USE_SLING_RELAY"; playerId: PlayerId; systemId: SystemId; planetId: PlanetId; unitType: UnitType; count: number },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "RR: this component action only applies during the action phase." };
  if (state.activePlayerId !== action.playerId) return { ok: false, error: "RR 4: it is not this player's turn." };
  if (state.pendingTacticalAction) return { ok: false, error: "Cannot use this with a tactical action in progress." };

  const player = state.players[action.playerId];
  const techCheck = ownsReadiedTech(player, "sling_relay");
  if (!techCheck.ok) return techCheck;

  const productionResult = executeProduction(state, action.playerId, action.systemId, action.planetId, [{ unitType: action.unitType, count: action.count }], rules);
  if (!productionResult.ok) return productionResult;

  let nextState = productionResult.state;
  nextState = {
    ...nextState,
    players: { ...nextState.players, [action.playerId]: exhaustTech(nextState.players[action.playerId], "sling_relay") },
  };
  // RR: this is a component ACTION — it uses this player's entire turn, same as PASS/finishing a tactical/strategic action.
  nextState = advanceActivePlayer(nextState);
  return { ok: true, state: nextState, events: productionResult.events };
}

function setExplored(state: GameState, systemId: SystemId, planetId: PlanetId): GameState {
  const system = state.systems[systemId];
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, explored: true } : p)),
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}
