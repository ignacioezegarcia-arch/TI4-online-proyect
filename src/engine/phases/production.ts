import { GameState, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId } from "../types/ids";
import { UnitType, SHIP_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getEffectivePlanetStats } from "../rules/planetStats";
import { advanceActivePlayer } from "./actionPhase";

/**
 * RR 78 STEP 5 — PRODUCTION (RR 58/59), tactical-action version (units
 * produced this way must go in the same system as the producing unit —
 * the separate "second Production" Strategy Card ability that lets you
 * build in a system you're not activating isn't this action, and isn't
 * built yet).
 *
 * SCOPE CUT, flagged rather than silently wrong:
 *  - Spends straight from player.resourcesAvailable/tradeGoods as one pool.
 *    Real RR 26 resource-spending exhausts SPECIFIC planets to raise that
 *    amount; this engine doesn't track per-planet exhaustion-for-resources
 *    anywhere yet (GameState.ts's own comment already flags
 *    resourcesAvailable/influenceAvailable as "derived cache — not
 *    authoritative"; that derivation doesn't exist yet either). Until it
 *    does, this just decrements the cached numbers directly.
 *  - Production limit for a Space Dock = that planet's EFFECTIVE resources
 *    (base + exploration attachments, see rules/planetStats.ts) + 2 (RR
 *    58's base formula). Doesn't yet special-case Space Dock II or any
 *    other producer with a different formula/value — there's currently
 *    only the one Production-granting unit in the data, so there's nothing
 *    to special-case against yet; flagged so it isn't silently assumed
 *    correct once there is.
 *  - No reinforcement-supply limit (RR: can't produce more of a unit than
 *    you have physical tokens left) — not tracked anywhere yet.
 *  - Structures (second Space Dock, PDS) can be "produced" here with no
 *    check that a planet only ever has one Space Dock, or any prerequisite
 *    tech check for PDS.
 */
export function produceUnits(
  state: GameState,
  action: { type: "PRODUCE_UNITS"; playerId: PlayerId; planetId: PlanetId; units: { unitType: UnitType; count: number }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 58: no tactical action in progress for this player." };
  }
  if (pending.step !== "production") {
    return { ok: false, error: `RR 58: expected step "production", got "${pending.step}".` };
  }
  return executeProduction(state, action.playerId, pending.systemId, action.planetId, action.units, rules);
}

/**
 * The actual RR 58/59 production mechanics, independent of the tactical
 * action context — also called by the Warfare strategy card's secondary
 * ability (RR: "use the Production ability of one of your space docks"
 * outside your own tactical action), which needs the exact same rules but
 * has no pendingTacticalAction to read a systemId from.
 */
export function executeProduction(
  state: GameState,
  playerId: PlayerId,
  systemId: SystemId,
  planetId: PlanetId,
  units: { unitType: UnitType; count: number }[],
  rules: RuleData,
): ActionResult {
  const system = state.systems[systemId];
  if (!system) return { ok: false, error: `No system ${systemId}.` };
  const planet = system.planets.find((p) => p.planetId === planetId);
  if (!planet) return { ok: false, error: `No planet ${planetId} in ${systemId}.` };
  if (planet.controllerId !== playerId) {
    return { ok: false, error: `RR 58: this player doesn't control ${planetId}.` };
  }

  const player = state.players[playerId];
  const producerStacks = planet.unitsByPlayer[playerId] ?? [];
  let productionLimit: number | null = null;
  for (const stack of producerStacks) {
    if (stack.count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    if (stats?.abilities.includes("production")) {
      const planetStats = getEffectivePlanetStats(planet, planetId, rules);
      productionLimit = planetStats.resources + 2;
      break;
    }
  }
  if (productionLimit === null) {
    return { ok: false, error: `RR 58: no Production-capable unit (e.g. a Space Dock) on ${planetId}.` };
  }

  let totalCost = 0;
  const resolvedUnits: { unitType: UnitType; count: number; unitCost: number }[] = [];
  for (const { unitType, count } of units) {
    if (count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats) return { ok: false, error: `No stats for ${unitType}.` };
    const perToken = stats.producesQuantity ?? 1;
    if (count % perToken !== 0) {
      return { ok: false, error: `RR 58: ${unitType} is produced ${perToken} at a time — ${count} isn't a multiple of that.` };
    }
    const tokens = count / perToken;
    totalCost += tokens * stats.cost;
    resolvedUnits.push({ unitType, count, unitCost: stats.cost });
  }

  if (totalCost > productionLimit) {
    return { ok: false, error: `RR 58: total cost ${totalCost} exceeds this Space Dock's Production limit (${productionLimit}).` };
  }
  const spendable = player.resourcesAvailable + player.tradeGoods;
  if (totalCost > spendable) {
    return { ok: false, error: `Not enough resources: need ${totalCost}, have ${spendable} (resources + trade goods).` };
  }

  const spentFromResources = Math.min(totalCost, player.resourcesAvailable);
  const spentFromTradeGoods = totalCost - spentFromResources;

  let updatedSpaceStacks = (system.spaceUnitsByPlayer[playerId] ?? []).map((s) => ({ ...s }));
  let updatedPlanetStacks = producerStacks.map((s) => ({ ...s }));
  const events: GameEvent[] = [];

  for (const { unitType, count, unitCost } of resolvedUnits) {
    const isShip = SHIP_TYPES.includes(unitType);
    const target = isShip ? updatedSpaceStacks : updatedPlanetStacks;
    const existing = target.find((s) => s.unitType === unitType && !s.upgradeId);
    if (existing) existing.count += count;
    else target.push({ unitType, count, damagedCount: 0 });
    if (isShip) updatedSpaceStacks = target;
    else updatedPlanetStacks = target;
    events.push({
      type: "UNITS_PRODUCED",
      playerId,
      systemId,
      planetId,
      unitType,
      count,
      totalCost: (count / (getUnitStats(rules, player.factionId, unitType, player.unitUpgrades)?.producesQuantity ?? 1)) * unitCost,
    });
  }

  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: updatedPlanetStacks } };
  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [playerId]: updatedSpaceStacks },
    planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)),
  };

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        resourcesAvailable: player.resourcesAvailable - spentFromResources,
        tradeGoods: player.tradeGoods - spentFromTradeGoods,
      },
    },
  };

  return { ok: true, state: nextState, events };
}

/** RR 78: closes out the tactical action and advances the turn — see this action's own doc comment in Actions.ts for why it had to exist. */
export function finishTacticalAction(
  state: GameState,
  action: { type: "FINISH_TACTICAL_ACTION"; playerId: PlayerId },
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 78: no tactical action in progress for this player." };
  }
  if (pending.step !== "production") {
    return { ok: false, error: `RR 78: a tactical action can only be finished from the "production" step, currently at "${pending.step}".` };
  }

  const nextState = advanceActivePlayer({ ...state, pendingTacticalAction: null });
  return { ok: true, state: nextState, events: [] };
}
