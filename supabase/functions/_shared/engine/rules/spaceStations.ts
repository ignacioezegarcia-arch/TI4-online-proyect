import { GameState, PlanetState, SystemState } from "../types/GameState";
import { SystemId, PlayerId } from "../types/ids";

/**
 * TE SPACE STATIONS (rulebook p.10): "A player gains control of a space
 * station from the deck or from another player when they are the only
 * player that has ships in its system. They do not lose control of the
 * station if those ships move out of its system." — so this only ever
 * GAINS control for whoever becomes the sole ship-owner present; it
 * never clears control just because a system empties out or gets a 2nd
 * player's ships added. "Gained exhausted" applies the same as any
 * other newly-gained planet.
 *
 * Called from every choke point where a system's own ship presence
 * could change (movement, retreats, combat destroying ships down to 1
 * owner) — see rules/movement.ts's own moveShips, phases/spaceCombat.ts's
 * own moveAllShips and wrapUpSpaceCombat-equivalent, for the actual call
 * sites. A no-op if this system has no space station planet at all, or
 * if there isn't currently exactly 1 player with ships present.
 */
export function resolveSpaceStationControl(state: GameState, systemId: SystemId): GameState {
  const system = state.systems[systemId];
  if (!system) return state;
  const stationPlanet = system.planets.find((p) => p.isSpaceStation);
  if (!stationPlanet) return state;

  const ownersWithShips = Object.entries(system.spaceUnitsByPlayer)
    .filter(([, stacks]) => (stacks ?? []).some((s) => s.count > 0))
    .map(([id]) => id as PlayerId);

  if (ownersWithShips.length !== 1) return state;
  const soleOwner = ownersWithShips[0];
  if (stationPlanet.controllerId === soleOwner) return state;

  const updatedPlanet: PlanetState = { ...stationPlanet, controllerId: soleOwner, exhausted: true };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === stationPlanet.planetId ? updatedPlanet : p)) };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}

/** Every SystemId that currently has a space station planet controlled by this player — used by rules/RuleData.ts-adjacent commodity-max computation and the transaction-eligibility check below. */
export function spaceStationsControlledBy(state: GameState, playerId: PlayerId): SystemId[] {
  return Object.entries(state.systems)
    .filter(([, sys]) => sys.planets.some((p) => p.isSpaceStation && p.controllerId === playerId))
    .map(([id]) => id as SystemId);
}

/** TE SPACE STATIONS: "A player's commodity value is increased by 1 for each space station they control." Added on top of whatever this player's own faction commoditiesMax already is — call this instead of reading rules.factions[...].commoditiesMax directly wherever a player's CURRENT max commodities actually matters (replenishing at the strategy phase, checking Custodia-Vigilia-style bonuses, etc.). */
export function effectiveCommoditiesMax(state: GameState, playerId: PlayerId, baseCommoditiesMax: number): number {
  return baseCommoditiesMax + spaceStationsControlledBy(state, playerId).length;
}

/** TE SPACE STATIONS: "Players can exhaust a space station at any time to convert their commodities to trade goods." Matches the standard 1-for-1 commodities->trade-goods conversion already used elsewhere in this project, just gated on owning an UN-exhausted space station specifically (any one of them — the ability doesn't require a particular one). */
export function convertCommoditiesViaSpaceStation(
  state: GameState,
  action: { type: "CONVERT_COMMODITIES_VIA_SPACE_STATION"; playerId: PlayerId; spaceStationPlanetId: import("../types/ids").PlanetId },
): import("../types/Actions").ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemIdRaw, system] of Object.entries(state.systems)) {
    const systemId = systemIdRaw as SystemId;
    const planet = system.planets.find((p) => p.planetId === action.spaceStationPlanetId);
    if (planet) {
      found = { systemId, system, planet };
      break;
    }
  }
  if (!found || !found.planet.isSpaceStation || found.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player doesn't control that space station." };
  }
  if (found.planet.exhausted) return { ok: false, error: "That space station is already exhausted." };
  if (player.commodities <= 0) return { ok: false, error: "No commodities to convert." };

  const convertedAmount = player.commodities;
  const updatedPlanet: PlanetState = { ...found.planet, exhausted: true };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.spaceStationPlanetId ? updatedPlanet : p)) };
  const updatedPlayer = { ...player, tradeGoods: player.tradeGoods + player.commodities, commodities: 0 };
  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [found.systemId]: updatedSystem }, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "COMMODITIES_CONVERTED_VIA_SPACE_STATION", playerId: action.playerId, amount: convertedAmount }],
  };
}
