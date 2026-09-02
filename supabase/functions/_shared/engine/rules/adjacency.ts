import { GameState } from "../types/GameState";
import { SystemId, asSystemId, AgendaId, PlayerId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { WormholeType } from "../types/enums";
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
export function getAdjacentSystems(
  state: GameState,
  systemId: SystemId,
  rules?: RuleData,
  /** Jol-Nar "Spatial Conduit Cylinder" (faction tech, exhaustable): "Exhaust after you activate a system that contains 1 or more of your units; that system is treated as adjacent to all other systems that contain 1 or more of your units during this system activation." Confirmed (tirules2.com/F_jol_nar): gravity-rift removal rolls still apply, and ships can still pass THROUGH intermediate systems en route (this is an adjacency override for the purposes of things that check adjacency directly, not a teleport that removes movement mechanics entirely). Player-specific — unlike every OTHER adjacency source in this function, this one only ever applies for the ONE player who activated it, checked via this optional param (defaults to not applying at all, for every call site that doesn't pass it). */
  forPlayerId?: PlayerId,
): SystemId[] {
  const physical = state.boardAdjacency[systemId] ?? [];
  const thisSystem = state.systems[systemId];
  let bySystemWormholes = thisSystem?.wormholes ?? [];

  // Winnu "Lazax Gate Folding" (faction technology): "During your
  // tactical actions, if you do not control Mecatol Rex, treat its
  // system as if it contains both an alpha and beta wormhole." Confirmed
  // (yjmrobert.com/tirules/factions/f_winnu): "may cause the Mecatol Rex
  // system to be adjacent to other systems containing an alpha or beta
  // wormhole for ALL PLAYERS during the Winnu player's tactical
  // actions" and "the Winnu player may become neighbors with other
  // players via Lazax Gate Folding" — i.e. this genuinely changes what
  // Mecatol Rex's system's own wormhole list IS during Winnu's own
  // tactical action, not just what Winnu personally perceives, so it's
  // injected here unconditionally (not gated to forPlayerId === Winnu)
  // whenever the condition holds, same as any other system-wide wormhole
  // source above/below. NOT specifically handled: the narrower Deep
  // Space Cannon / retreat-through-Mecatol interactions this same
  // effect also enables for OTHER players (flagged in rules/winnu.ts's
  // own useLazaxGateFolding doc comment) — this only covers the
  // adjacency computation itself.
  if (rules?.mecatolSystemId === systemId) {
    const winnuPlayer = Object.values(state.players).find((p) => p.factionId === ("winnu" as never));
    const mecatolPlanet = thisSystem?.planets.find((p) => rules?.planets[p.planetId]?.isMecatolRex);
    const winnuControlsMecatol = mecatolPlanet?.controllerId === winnuPlayer?.id;
    const winnuHasTech = !!winnuPlayer?.technologies.includes("lazax_gate_folding" as never);
    const isWinnusOwnTacticalAction = state.pendingTacticalAction?.playerId === winnuPlayer?.id;
    if (winnuPlayer && winnuHasTech && !winnuControlsMecatol && isWinnusOwnTacticalAction) {
      bySystemWormholes = [...bySystemWormholes, "alpha" as WormholeType, "beta" as WormholeType];
    }
  }

  let wormholeLinked: SystemId[] = [];
  if (bySystemWormholes.length > 0) {
    // Ghosts of Creuss "QUANTUM ENTANGLEMENT" (faction ability): "You
    // treat all systems that contain either an alpha or beta wormhole
    // as adjacent to each other. Game effects cannot prevent you from
    // using this ability." Confirmed (yjmrobert.com/tirules/factions/f_creuss):
    // "the effect of the Enforced Travel Ban law does not affect the
    // Creuss player" — bypasses that filter entirely, below, when
    // forPlayerId is the Creuss player specifically (never for anyone
    // else — this is explicitly THEIR OWN ability, unlike Wormhole
    // Reconstruction's own global version of the same union rule).
    const quantumEntanglementActive = !!forPlayerId && rules?.factions[state.players[forPlayerId]?.factionId]?.factionAbilityIds?.includes("quantum_entanglement" as never);

    // RR "Enforced Travel Ban" ("for"): alpha and beta wormholes have no
    // effect during movement while this law is active — filtered out
    // entirely before the matching-type check below even runs.
    const enforcedTravelBan = isLawActiveWithOutcome(state, "enforced_travel_ban" as AgendaId, "for") && !quantumEntanglementActive;
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

    if (effectiveWormholes.length > 0) {
      // RR "Wormhole Reconstruction" ("for") / "Lost Star Chart" (this
      // player's own action card, this tactical action only): confirmed,
      // ALL systems that contain EITHER an alpha or a beta wormhole become
      // mutually adjacent to EACH OTHER — a looser UNION than the normal
      // matching-type rule (alpha only links to alpha, beta only to
      // beta); only applies when this system's own qualifying wormhole is
      // itself alpha or beta. Both sources share the exact same
      // mechanic, just a permanent law vs. a 1-tactical-action card — no
      // need to distinguish them past this line.
      const wormholeReconstruction =
        isLawActiveWithOutcome(state, "wormhole_reconstruction" as AgendaId, "for") || Boolean(state.pendingTacticalAction?.lostStarChartActive) || quantumEntanglementActive;
      const hasAlphaOrBeta = effectiveWormholes.some((w) => w === "alpha" || w === "beta");

      wormholeLinked = Object.values(state.systems)
        .filter((sys) => sys.systemId !== systemId)
        .filter((sys) =>
          wormholeReconstruction && hasAlphaOrBeta
            ? sys.wormholes.some((w) => w === "alpha" || w === "beta")
            : sys.wormholes.some((w) => effectiveWormholes.includes(w)),
        )
        .map((sys) => sys.systemId);
    }
  }

  // TE INCURSION (Crimson Rebellion): "systems that contain active
  // breaches are adjacent" — a looser mutual-adjacency rule (every active
  // breach system links to every OTHER active breach system), same shape
  // as Wormhole Reconstruction's own alpha/beta union above, just keyed
  // off breachState instead of wormhole type. Applies for every player,
  // not just the Rebellion — the ability text itself isn't scoped to them.
  const breachLinked: SystemId[] =
    thisSystem?.breachState === "active"
      ? Object.values(state.systems)
          .filter((sys) => sys.systemId !== systemId && sys.breachState === "active")
          .map((sys) => sys.systemId)
      : [];

  // TE The Fracture: ingress<->egress is a ONE-WAY-LABELED but
  // effectively mutual cross-connection — an ingress system is adjacent
  // to every Fracture system with an egress token, and (checked from the
  // other side, when getAdjacentSystems is called ON that Fracture
  // system instead) every egress Fracture system is adjacent to every
  // ingress system. Deliberately NOT ingress<->ingress or egress<->egress
  // (confirmed: "ingress systems are not adjacent to other ingress
  // systems, and egress systems are not adjacent to other egress
  // systems") — each side only ever links to the OTHER kind.
  let fractureLinked: SystemId[] = [];
  if (thisSystem?.ingressToken) {
    fractureLinked = Object.values(state.systems)
      .filter((sys) => sys.isFracture && sys.egressToken)
      .map((sys) => sys.systemId);
  } else if (thisSystem?.isFracture && thisSystem?.egressToken) {
    fractureLinked = Object.values(state.systems)
      .filter((sys) => sys.ingressToken)
      .map((sys) => sys.systemId);
  }

  // Jol-Nar "Spatial Conduit Cylinder": only relevant if THIS is the specific system the specific player activated it in, this same tactical action.
  let spatialConduitLinked: SystemId[] = [];
  const conduitState = state.pendingTacticalAction?.spatialConduitCylinderActive;
  if (forPlayerId && conduitState && conduitState.playerId === forPlayerId && conduitState.systemId === systemId) {
    spatialConduitLinked = Object.entries(state.systems)
      .filter(([sysId, sys]) => sysId !== systemId && (sys.spaceUnitsByPlayer[forPlayerId] ?? []).some((s) => s.count > 0))
      .map(([sysId]) => sysId as SystemId);
  }

  // Ghosts of Creuss "Emissary Taivra" (agent): "After a player
  // activates a system that contains a non-delta wormhole: You may
  // exhaust this card; if you do, that system is adjacent to all other
  // systems that contain a wormhole during this tactical action."
  // Confirmed (yjmrobert.com/tirules/factions/f_creuss): "a delta
  // wormhole in the system (such as from the Hil Colish) does NOT
  // prevent this ability from being usable" (only relevant to the
  // TRIGGER condition — must have a NON-delta wormhole to activate,
  // checked in rules/creuss.ts's own useEmissaryTaivra, not here) —
  // "if used, the active system will be adjacent to systems with delta
  // wormholes" too (this adjacency expansion below is NOT restricted to
  // non-delta targets, only the trigger condition is). Same
  // per-activation flag shape as Spatial Conduit Cylinder above, but
  // NOT player-specific (any player querying adjacency from THIS
  // system sees the expanded set, since the ability changes the
  // system's own adjacency, not just this player's perception of it).
  let emissaryTaivraLinked: SystemId[] = [];
  if (state.pendingTacticalAction?.emissaryTaivraActiveSystemId === systemId) {
    emissaryTaivraLinked = Object.entries(state.systems)
      .filter(([sysId, sys]) => sysId !== systemId && sys.wormholes.length > 0)
      .map(([sysId]) => sysId as SystemId);
  }

  return Array.from(new Set([...physical, ...wormholeLinked, ...breachLinked, ...fractureLinked, ...spatialConduitLinked, ...emissaryTaivraLinked]));
}

export function isAdjacent(state: GameState, a: SystemId, b: SystemId, rules?: RuleData): boolean {
  return getAdjacentSystems(state, a, rules).includes(b);
}

/** RR 60 NEIGHBORS: two players are neighbors if either has a controlled planet in a system that's the same as, or adjacent to, a system where the other has a controlled planet. Shared by objectiveChecks.ts's own inline version of this same check and RR "Minister of Commerce". */
/**
 * RR "Neighbors": "Two players are neighbors if they both have a unit or
 * control a planet in the same system. They are also neighbors if they
 * both have a unit or control a planet in systems that are adjacent to
 * each other." Previously this only checked planet control — fixed to
 * also count ship/ground-force presence, which matters e.g. for
 * Transactions during combat ("neighbors only in the active system" via
 * their ships being there, not necessarily controlling any planet there).
 */
export function arePlayersNeighbors(state: GameState, playerIdA: import("../types/ids").PlayerId, playerIdB: import("../types/ids").PlayerId, rules?: RuleData): boolean {
  if (playerIdA === playerIdB) return false;
  const hasPresence = (system: import("../types/GameState").SystemState, playerId: import("../types/ids").PlayerId) =>
    system.planets.some((p) => p.controllerId === playerId) ||
    (system.spaceUnitsByPlayer[playerId] ?? []).some((s) => s.count > 0) ||
    system.planets.some((p) => (p.unitsByPlayer[playerId] ?? []).some((s) => s.count > 0));
  const aSystems = Object.entries(state.systems).filter(([, s]) => hasPresence(s, playerIdA)).map(([id]) => id as SystemId);
  const bSystems = Object.entries(state.systems).filter(([, s]) => hasPresence(s, playerIdB)).map(([id]) => id as SystemId);
  const bSystemIds = new Set(bSystems);
  const aSystemIds = new Set(aSystems);
  // Ghosts of Creuss "QUANTUM ENTANGLEMENT": confirmed
  // (yjmrobert.com/tirules/factions/f_creuss) — "if the Creuss player
  // has units or controls planets in a system with an alpha wormhole,
  // and another player has units or controls planets in a system with
  // a beta wormhole, or vice versa, then the Creuss player and that
  // player are neighbors" (enabling e.g. Mentak's own Pillage against
  // Creuss this way). Checked symmetrically here — FROM each of A's own
  // systems using A's own forPlayerId (so A's own Quantum Entanglement,
  // if they have it, applies), AND separately FROM each of B's own
  // systems using B's own forPlayerId — never applying one player's
  // own ability to the OTHER player's systems, which wouldn't make
  // sense (this ability only ever expands the OWNER's own perception of
  // adjacency from THEIR OWN presence).
  return (
    aSystems.some((sysId) => [sysId, ...getAdjacentSystems(state, sysId, rules, playerIdA)].some((id) => bSystemIds.has(id))) ||
    bSystems.some((sysId) => [sysId, ...getAdjacentSystems(state, sysId, rules, playerIdB)].some((id) => aSystemIds.has(id)))
  );
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
