import { GameState } from "../types/GameState";
import { SystemId, asSystemId, AgendaId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { isLawActiveWithOutcome } from "../phases/agendaEffects";

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
 *
 * `rules` is OPTIONAL — only needed for RR "Nexus Sovereignty"'s own
 * narrower check (scoped to the specific Wormhole Nexus system id, which
 * lives in RuleData); every other agenda hook here only needs `state`.
 * Callers that don't have `rules` handy (e.g. objectiveChecks.ts's
 * proximity-style checks) simply don't get that one narrow case checked —
 * a reasonable, flagged simplification rather than threading `rules`
 * through every single caller for one edge case.
 */
export function getAdjacentSystems(state: GameState, systemId: SystemId, rules?: RuleData): SystemId[] {
  const physical = state.boardAdjacency[systemId] ?? [];
  const bySystemWormholes = state.systems[systemId]?.wormholes ?? [];
  if (bySystemWormholes.length === 0) return physical;

  // RR "Enforced Travel Ban" ("for"): alpha and beta wormholes have no
  // effect during movement while this law is active — filtered out
  // entirely before the matching-type check below even runs.
  const enforcedTravelBan = isLawActiveWithOutcome(state, "enforced_travel_ban" as AgendaId, "for");
  // RR "Nexus Sovereignty" ("for"): same idea, but scoped to JUST the
  // Wormhole Nexus's own alpha/beta wormholes (its gamma wormhole, and
  // every other system's own alpha/beta wormholes, are unaffected).
  const nexusSovereignty = isLawActiveWithOutcome(state, "nexus_sovereignty" as AgendaId, "for");
  const isNexusSystem = rules?.wormholeNexusSystemId === systemId;

  const effectiveWormholes = bySystemWormholes.filter((w) => {
    if (w !== "alpha" && w !== "beta") return true;
    if (enforcedTravelBan) return false;
    if (nexusSovereignty && isNexusSystem) return false;
    return true;
  });
  if (effectiveWormholes.length === 0) return physical;

  // RR "Wormhole Reconstruction" ("for"): confirmed, ALL systems that
  // contain EITHER an alpha or a beta wormhole become mutually adjacent to
  // EACH OTHER — a looser UNION than the normal matching-type rule (alpha
  // only links to alpha, beta only to beta); only applies when this
  // system's own qualifying wormhole is itself alpha or beta.
  const wormholeReconstruction = isLawActiveWithOutcome(state, "wormhole_reconstruction" as AgendaId, "for");
  const hasAlphaOrBeta = effectiveWormholes.some((w) => w === "alpha" || w === "beta");

  const wormholeLinked = Object.values(state.systems)
    .filter((sys) => sys.systemId !== systemId)
    .filter((sys) =>
      wormholeReconstruction && hasAlphaOrBeta
        ? sys.wormholes.some((w) => w === "alpha" || w === "beta")
        : sys.wormholes.some((w) => effectiveWormholes.includes(w)),
    )
    .map((sys) => sys.systemId);

  return Array.from(new Set([...physical, ...wormholeLinked]));
}

export function isAdjacent(state: GameState, a: SystemId, b: SystemId, rules?: RuleData): boolean {
  return getAdjacentSystems(state, a, rules).includes(b);
}

/** RR 60 NEIGHBORS: two players are neighbors if either has a controlled planet in a system that's the same as, or adjacent to, a system where the other has a controlled planet. Shared by objectiveChecks.ts's own inline version of this same check and RR "Minister of Commerce". */
export function arePlayersNeighbors(state: GameState, playerIdA: import("../types/ids").PlayerId, playerIdB: import("../types/ids").PlayerId, rules?: RuleData): boolean {
  if (playerIdA === playerIdB) return false;
  const aSystems = Object.entries(state.systems).filter(([, s]) => s.planets.some((p) => p.controllerId === playerIdA));
  const bSystemIds = new Set(Object.entries(state.systems).filter(([, s]) => s.planets.some((p) => p.controllerId === playerIdB)).map(([id]) => id));
  return aSystems.some(([sysId]) => [sysId, ...getAdjacentSystems(state, sysId as SystemId, rules)].some((id) => bSystemIds.has(id)));
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
