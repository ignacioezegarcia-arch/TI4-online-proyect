import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId, asPlanetId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { getAdjacentSystems } from "./adjacency";
import { checkReinforcementsAvailable } from "./reinforcements";
import { findControlledLegendaryPlanet, exhaustLegendaryAbility } from "../phases/legendaryPlanets";

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
