import { GameState } from "../types/GameState";
import { SystemId } from "../types/ids";

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
