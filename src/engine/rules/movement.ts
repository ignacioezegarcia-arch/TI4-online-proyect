import { GameState } from "../types/GameState";
import { RuleData } from "../types/RuleData";
import { PlayerId, SystemId, AgendaId } from "../types/ids";
import { getAdjacentSystems } from "./adjacency";
import { canShipEnterTile, canShipPassThroughTile, hasGravityRift, hasNebula } from "./anomalies";
import { playersWithShipsInSystem } from "./combat";
import { isLawActiveWithOutcome } from "../phases/agendaEffects";

/**
 * RR 49 MOVEMENT (matches this codebase's existing citation convention for
 * this rule — see RuleData.ts and the "RR 49.4" own-command-token check a
 * few lines up the call stack in tacticalAction.ts. TI4's Rules Reference is
 * alphabetized by topic, not sequential, so exact section numbers shift
 * between printings/FAQ updates; worth double-checking once the official
 * PDFs are uploaded per the project's own plan, but not worth mixing two
 * different numbering schemes in the same codebase in the meantime).
 *
 * Determines whether a ship with the given base move value can legally
 * travel from `from` to `to` (the system being activated this tactical
 * action), obeying every movement-legality rule at once:
 *
 *  - "The ship cannot move through a system that contains ships controlled
 *    by another player" — no exception for fighters. (This file's previous
 *    version assumed fighters didn't block; that was true pre-1.1 errata,
 *    corrected here — confirmed against the current Living Rules
 *    Reference.) This ONLY applies to systems entered mid-path; ending
 *    movement in a system with enemy ships is exactly how space combat gets
 *    triggered, so `to` itself is exempt.
 *  - RR 9: Asteroid Field / Supernova block entry and pass-through outright.
 *    Nebula can only be entered as the active system, never as a mid-path
 *    stop, and — since that means a ship can only ever be "leaving" a Nebula
 *    if its movement started there — overrides that ship's move value to 1
 *    for this action (RR 9, Nebula).
 *  - RR 9 (Gravity Rift): grants +1 move value if the ship's path starts in,
 *    or passes through, at least one gravity rift — applied ONCE for the
 *    whole path no matter how many rifts it touches (RR 9.7). The
 *    destruction die-roll that also happens is deliberately NOT applied
 *    here — see anomalies.ts's doc comment on destructionCheck for why.
 *
 * Antimass Deflectors (ignore asteroid fields, both entering and passing
 * through) and Light Wave Deflector (ignore enemy-fleet blocking mid-path)
 * are opted into via the `techs` param below — the caller (tacticalAction.ts's
 * moveShips) is what actually checks the moving player's owned technologies
 * and passes the right flags in; this function only applies them.
 */
export function canShipReachSystem(
  state: GameState,
  playerId: PlayerId,
  from: SystemId,
  to: SystemId,
  baseMoveValue: number,
  techs: { ignoreAsteroidFields?: boolean; ignoreEnemyFleets?: boolean } = {},
  rules?: RuleData,
): boolean {
  if (from === to) return true;

  const originAnomalies = state.systems[from]?.anomalies ?? [];
  // Nebula overrides (doesn't add to) the ship's move value when leaving it.
  // A gravity-rift-plus-nebula combo tile would be a genuine rules edge case
  // (which wins?) — rare enough in practice that we take nebula's clamp as
  // authoritative here rather than guess an interaction order.
  // RR "Shared Research" ("for"): units can move through nebulae as normal
  // while this law is active — the clamp below is simply skipped.
  const nebulaClampLifted = isLawActiveWithOutcome(state, "shared_research" as AgendaId, "for");
  const maxBudget = hasNebula(originAnomalies) && !nebulaClampLifted ? 1 : baseMoveValue;
  if (maxBudget <= 0) return false;

  // BFS where the state is (system, hasUsedRiftBonus) rather than just
  // system, because the same system can be reached with or without having
  // banked the gravity-rift bonus, and that changes how many hops remain
  // available for the rest of the path.
  const startRiftUsed = hasGravityRift(originAnomalies);
  const bestHopsForState = new Map<string, number>();
  bestHopsForState.set(stateKey(from, startRiftUsed), 0);
  let frontier: { systemId: SystemId; hops: number; riftUsed: boolean }[] = [
    { systemId: from, hops: 0, riftUsed: startRiftUsed },
  ];

  while (frontier.length > 0) {
    const nextFrontier: typeof frontier = [];

    for (const current of frontier) {
      const budget = maxBudget + (current.riftUsed ? 1 : 0);
      if (current.hops >= budget) continue;

      for (const neighborId of getAdjacentSystems(state, current.systemId, rules)) {
        const hops = current.hops + 1;
        if (hops > budget) continue;

        const isDestination = neighborId === to;
        const neighborAnomalies = state.systems[neighborId]?.anomalies ?? [];

        if (isDestination) {
          if (!canShipEnterTile(neighborAnomalies, { isActiveSystem: true, ignoreAsteroidFields: techs.ignoreAsteroidFields })) continue;
          return true;
        }

        if (!canShipPassThroughTile(neighborAnomalies, techs.ignoreAsteroidFields)) continue;
        const blockedByEnemyFleet =
          !techs.ignoreEnemyFleets && playersWithShipsInSystem(state, neighborId).some((p) => p !== playerId);
        if (blockedByEnemyFleet) continue;

        const riftUsed = current.riftUsed || hasGravityRift(neighborAnomalies);
        const key = stateKey(neighborId, riftUsed);
        const bestKnown = bestHopsForState.get(key);
        if (bestKnown !== undefined && bestKnown <= hops) continue;
        bestHopsForState.set(key, hops);
        nextFrontier.push({ systemId: neighborId, hops, riftUsed });
      }
    }

    frontier = nextFrontier;
  }

  return false;
}

function stateKey(systemId: SystemId, riftUsed: boolean): string {
  return `${systemId}|${riftUsed ? 1 : 0}`;
}
