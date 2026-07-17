import { GameState } from "../types/GameState";
import { SystemId, asSystemId } from "../types/ids";
import { RuleData } from "../types/RuleData";

/**
 * RR 6 ADJACENCY.
 * Two systems are adjacent if either:
 *   (a) their hex tiles physically touch (state.boardAdjacency, fixed at setup), or
 *   (b) they contain matching wormhole types (RR 6.1) — this is *live* state
 *       because wormholes can activate/change during play (Wormhole Nexus,
 *       Dark Energy Tap exploration, Creuss Gate, Thunder's Edge Fracture
 *       ingress/egress).
 *
 * This does NOT yet fold in Thunder's Edge ingress/egress-to-Fracture
 * adjacency (TE p.9: "A system that contains an ingress is adjacent to each
 * system in The Fracture that contains an egress") — that's a third,
 * asymmetric adjacency rule layered on top once Thunder's Edge support is
 * built. Flagged here so it isn't forgotten.
 */
export function getAdjacentSystems(state: GameState, systemId: SystemId): SystemId[] {
  const physical = state.boardAdjacency[systemId] ?? [];
  const bySystemWormholes = state.systems[systemId]?.wormholes ?? [];

  if (bySystemWormholes.length === 0) return physical;

  const wormholeLinked = Object.values(state.systems)
    .filter((sys) => sys.systemId !== systemId)
    .filter((sys) => sys.wormholes.some((w) => bySystemWormholes.includes(w)))
    .map((sys) => sys.systemId);

  return Array.from(new Set([...physical, ...wormholeLinked]));
}

export function isAdjacent(state: GameState, a: SystemId, b: SystemId): boolean {
  return getAdjacentSystems(state, a).includes(b);
}

/**
 * RR PoK "Wormhole Nexus": starts inactive (gamma-only wormhole, so it's
 * only adjacent to other gamma systems). The FIRST time a player moves or
 * places a unit into it, OR gains control of its planet (Mallice) —
 * whichever happens first — it flips active (alpha+beta+gamma), becoming
 * adjacent to any system with any of those three wormhole types. Call this
 * after either of those two triggers; it's a no-op if there's no Nexus in
 * this game (Base-only, or already active).
 *
 * Deliberately just flips SystemState.wormholes — getAdjacentSystems above
 * already re-reads that live on every query, so nothing else needs to
 * change for the new adjacency to take effect immediately.
 */
export function maybeActivateWormholeNexus(state: GameState, rules: RuleData, triggeringSystemId: SystemId): GameState {
  const nexusId = rules.wormholeNexusSystemId ? asSystemId(rules.wormholeNexusSystemId) : null;
  if (!nexusId || triggeringSystemId !== nexusId) return state;

  const system = state.systems[nexusId];
  if (!system || system.wormholes.length > 1) return state; // no Nexus placed this game, or already active

  return {
    ...state,
    systems: { ...state.systems, [nexusId]: { ...system, wormholes: ["alpha", "beta", "gamma"] } },
  };
}
