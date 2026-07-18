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
 * RR "Technology" — the standalone abilities of 8 exhaustable/passive
 * techs that don't fit the tactical-action-step handlers elsewhere (see
 * this project's own note on which techs live where): each is its own
 * GameAction rather than a modifier threaded through an existing one,
 * since none of them share a natural existing action to piggyback on the
 * way Gravity Drive rides MOVE_SHIPS or AI Development Algorithm rides
 * RESEARCH_UNIT_UPGRADE/PRODUCE_UNITS.
 *
 * Timing simplification, flagged rather than silently strict: Sling Relay,
 * Bio-Stims, and Predictive Intelligence's own "at the end of your turn" /
 * "when you activate a system" text isn't strictly gated to that exact
 * instant (this engine doesn't have a generic "was X the most recent thing
 * that happened" gate for every possible trigger — only for the ones
 * state.recentEvents already tracks) — offered any time during the action
 * phase (or, for Sling Relay/X-89, whenever it'd be this player's own
 * component-action turn) instead. Self-Assembly Routines, Dacxive
 * Animators, and Integrated Economy all check recentEvents directly
 * (production/ground-combat-win/control-gained are all tracked there
 * already), so those three ARE timing-accurate.
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

/** RR "Self-Assembly Routines": after this player uses PRODUCTION this tactical action, may exhaust this card to place 1 free mech on any planet THEY control in that same system (not necessarily the planet that produced, and not requiring a mech already be there). */
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

  const producedHere = (state.recentEvents ?? []).some(
    (e) => e.type === "UNITS_PRODUCED" && e.playerId === action.playerId && e.systemId === systemId,
  );
  if (!producedHere) {
    return { ok: false, error: "This player hasn't used Production in that system this tactical action." };
  }

  const stacks = planet.unitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "mech" && !s.upgradeId);
  const updatedStacks = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + 1 } : s))
    : [...stacks, { unitType: "mech" as UnitType, count: 1, damagedCount: 0 }];
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

/** RR "Bio-Stims": exhaust to ready EITHER 1 of this player's OWN planets that has a technology specialty, OR 1 of their OTHER (already-exhausted) technologies. RR text says "at the end of your turn" — not strictly gated to that exact instant (see this file's own header note on timing simplifications); offered any time during the action phase instead. */
export function useBioStims(
  state: GameState,
  action: { type: "USE_BIO_STIMS"; playerId: PlayerId; target: { kind: "planet"; planetId: PlanetId } | { kind: "technology"; techId: string } },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "RR: this ability only applies during the action phase." };
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  const techCheck = ownsReadiedTech(player, "bio_stims");
  if (!techCheck.ok) return techCheck;

  const target = action.target;
  if (target.kind === "planet") {
    const found = findPlanet(state, target.planetId);
    if (!found) return { ok: false, error: `No planet ${target.planetId}.` };
    const { systemId, system, planet } = found;
    if (planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
    if (!planet.exhausted) return { ok: false, error: "That planet is already readied." };
    if ((rules.planets[target.planetId]?.techSpecialties ?? []).length === 0) {
      return { ok: false, error: "That planet has no technology specialty." };
    }

    const updatedPlanet: PlanetState = { ...planet, exhausted: false };
    const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === target.planetId ? updatedPlanet : p)) };
    const nextState: GameState = {
      ...state,
      systems: { ...state.systems, [systemId]: updatedSystem },
      players: { ...state.players, [action.playerId]: exhaustTech(player, "bio_stims") },
    };
    return { ok: true, state: nextState, events: [] };
  }

  const otherTechId = asTechId(target.techId);
  if (otherTechId === asTechId("bio_stims")) {
    return { ok: false, error: "RR \"Bio-Stims\": can't target itself — must be 1 of the player's OTHER technologies." };
  }
  if (!player.technologies.includes(otherTechId)) return { ok: false, error: "This player doesn't own that technology." };
  if (!player.exhaustedTechnologies.includes(otherTechId)) return { ok: false, error: "That technology is already readied." };

  const updatedPlayer: Player = {
    ...exhaustTech(player, "bio_stims"),
    exhaustedTechnologies: exhaustTech(player, "bio_stims").exhaustedTechnologies.filter((id) => id !== otherTechId),
  };
  const nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } };
  return { ok: true, state: nextState, events: [] };
}

/** RR "Predictive Intelligence"'s OTHER ability (distinct from its agenda-vote-bonus one, but shares the same exhausted state): exhaust to redistribute this player's command tokens across their 3 pools, keeping the SAME total. RR text says "at the end of your turn" — same timing simplification as Bio-Stims/Sling Relay (see this file's own header note); offered any time during the action phase instead. */
export function usePredictiveIntelligenceRedistribute(
  state: GameState,
  action: { type: "USE_PREDICTIVE_INTELLIGENCE_REDISTRIBUTE"; playerId: PlayerId; tactic: number; fleet: number; strategy: number },
): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "RR: this ability only applies during the action phase." };
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  const techCheck = ownsReadiedTech(player, "predictive_intelligence");
  if (!techCheck.ok) return techCheck;

  if (action.tactic < 0 || action.fleet < 0 || action.strategy < 0) {
    return { ok: false, error: "Command token counts can't be negative." };
  }
  const currentTotal = player.commandTokens.tactic + player.commandTokens.fleet + player.commandTokens.strategy;
  const newTotal = action.tactic + action.fleet + action.strategy;
  if (newTotal !== currentTotal) {
    return { ok: false, error: `RR "Predictive Intelligen
