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
  techs: {
    ignoreAsteroidFields?: boolean;
    ignoreEnemyFleets?: boolean;
    ignoreAllAnomalyEffects?: boolean;
    circletOfTheVoidActive?: boolean;
    canMoveThroughSupernova?: boolean;
    /**
     * Clan of Saar "Captain Mendosa" (agent): confirmed
     * (yjmrobert.com/tirules/factions/f_saar, twilight-imperium.fandom.com/wiki/The_Clan_of_Saar):
     * "The nebula effect of setting the move value of all ships in that
     * system to one will be OVERWRITTEN by Captain Mendosa's effect" —
     * the one exception to Nebula's own clamp below, set by the caller
     * (phases/tacticalAction.ts's own moveShips) whenever this specific
     * move already had pendingTacticalAction.mendosaMoveOverride applied
     * to its effectiveMove. Does NOT lift the +1 gravity-rift bonus
     * (mendosaMoveOverride's own doc comment on GameState.ts already
     * confirms that modifier is separately excluded from Mendosa's own
     * computed value, so nothing extra is needed for that half here).
     */
    mendosaOverrideActive?: boolean;
    /**
     * Used ONLY to answer "is there a route that reaches `to` without
     * ever touching a gravity rift beyond `from` itself" — i.e. is going
     * through a mid-path rift actually OPTIONAL for this move, or the
     * ONLY way to make the trip. Confirmed
     * (yjmrobert.com/tirules/rules/r_gravity_rift): the origin's own
     * rift (if any) is unavoidable by definition (the ship starts
     * there), so this only forbids entering/passing through any OTHER
     * system that has one — see phases/tacticalAction.ts's own
     * moveShips, which runs this function twice (once normally, once
     * with this flag set) to tell "mandatory" mid-path rift use apart
     * from "the player's own optional choice".
     */
    forbidGravityRiftsBeyondOrigin?: boolean;
  } = {},
  rules?: RuleData,
  /**
   * Muaat "Stellar Genesis" breakthrough ability: "after you move 1 of
   * your war suns out of OR THROUGH Avernus's system..." — the "or
   * through" half needs to know whether the path ACTUALLY TAKEN visits
   * this specific system somewhere along the way, not just whether the
   * move is legal at all. Tracked as a 3rd BFS state dimension
   * (alongside riftUsed below) exactly the same way — a path either has
   * or hasn't visited it yet at each point, and once true it stays true
   * for the rest of that path. If undefined, behaves exactly as before
   * (no such tracking, no such requirement).
   */
  mustPassThroughSystemId?: SystemId,
): boolean {
  if (from === to) return true;
  const ignoreAsteroidFields = techs.ignoreAsteroidFields || techs.ignoreAllAnomalyEffects || techs.circletOfTheVoidActive;

  const originAnomalies = state.systems[from]?.anomalies ?? [];
  // Nebula overrides (doesn't add to) the ship's move value when leaving it.
  // A gravity-rift-plus-nebula combo tile would be a genuine rules edge case
  // (which wins?) — rare enough in practice that we take nebula's clamp as
  // authoritative here rather than guess an interaction order.
  // RR "Shared Research" ("for"): units can move through nebulae as normal
  // while this law is active — the clamp below is simply skipped.
  // "Nav Suite": same clamp-skip, this player's own action-card choice
  // instead of an active law — see this function's own `techs` param doc.
  const nebulaClampLifted =
    isLawActiveWithOutcome(state, "shared_research" as AgendaId, "for") || techs.ignoreAllAnomalyEffects || techs.circletOfTheVoidActive || techs.mendosaOverrideActive;
  const maxBudget = hasNebula(originAnomalies) && !nebulaClampLifted ? 1 : baseMoveValue;
  if (maxBudget <= 0) return false;

  // BFS where the state is (system, riftCount) rather than just system,
  // because the same system can be reached having banked different
  // numbers of gravity-rift bonuses, and that changes how many hops
  // remain available for the rest of the path. "Nav Suite"
  // (ignoreAllAnomalyEffects) forfeits the gravity-rift bonus along with
  // every other anomaly effect — flagged interpretation call: the card
  // says "ignore the effects of anomalies" without carving out an
  // exception for beneficial ones, so this treats the rift's own bonus
  // as one of those ignored effects too.
  // RR "Circlet of the Void" (relic): confirmed explicitly DIFFERENT —
  // "still applies the movement bonus" even while otherwise ignoring
  // anomaly movement effects — so circletOfTheVoidActive does NOT gate
  // this rift-bonus tracking the way ignoreAllAnomalyEffects does.
  // Confirmed (yjmrobert.com/tirules/rules/r_gravity_rift, note 6): "If a
  // ship moves through or out of multiple gravity rifts... each instance
  // will provide a +1 to movement" — a COUNT, not a one-time flag (this
  // used to be `riftUsed: boolean`, capping the bonus at +1 no matter how
  // many distinct rift systems a path touched; only DISTINCT rift systems
  // are counted here, not a system revisited a 2nd time within the same
  // path — a deliberate, flagged simplification, since re-visiting the
  // exact same rift to farm extra bonus hops is an exotic enough edge
  // case that modeling it would turn this from a standard shortest-path
  // BFS into a much harder "revisiting can be beneficial" search).
  const startRiftCount = hasGravityRift(originAnomalies) && !techs.ignoreAllAnomalyEffects ? 1 : 0;
  const startPassedThrough = mustPassThroughSystemId === undefined || from === mustPassThroughSystemId;
  const bestHopsForState = new Map<string, number>();
  bestHopsForState.set(stateKey(from, startRiftCount, startPassedThrough), 0);
  let frontier: { systemId: SystemId; hops: number; riftCount: number; riftSystemsTouched: Set<SystemId>; passedThrough: boolean }[] = [
    { systemId: from, hops: 0, riftCount: startRiftCount, riftSystemsTouched: hasGravityRift(originAnomalies) ? new Set([from]) : new Set(), passedThrough: startPassedThrough },
  ];

  while (frontier.length > 0) {
    const nextFrontier: typeof frontier = [];

    for (const current of frontier) {
      const budget = maxBudget + current.riftCount;
      if (current.hops >= budget) continue;

      for (const neighborId of getAdjacentSystems(state, current.systemId, rules, playerId)) {
        const hops = current.hops + 1;
        if (hops > budget) continue;

        const isDestination = neighborId === to;
        const neighborAnomalies = state.systems[neighborId]?.anomalies ?? [];
        const passedThrough = current.passedThrough || neighborId === mustPassThroughSystemId;

        if (isDestination) {
          if (!canShipEnterTile(neighborAnomalies, { isActiveSystem: true, ignoreAsteroidFields, bypassAllBlocking: techs.circletOfTheVoidActive, ignoreSupernova: techs.canMoveThroughSupernova || techs.ignoreAllAnomalyEffects })) continue;
          if (passedThrough) return true;
          // Doesn't satisfy mustPassThroughSystemId via THIS path — keep exploring other paths/hop-counts instead of returning early, same as any other non-final state.
          continue;
        }

        // See this function's own techs.forbidGravityRiftsBeyondOrigin doc comment above — used only to answer "is a rift-free route possible at all", never during a real move. Confirmed (yjmrobert.com/tirules/rules/r_gravity_rift, note 1): "moving into a gravity rift... as the active system... will not provide the +1, nor will the ships have to roll for removal" — so this must NEVER apply to the destination itself (already handled by the isDestination branch returning above), only to genuine mid-path stops.
        if (techs.forbidGravityRiftsBeyondOrigin && hasGravityRift(neighborAnomalies)) continue;

        if (!canShipPassThroughTile(neighborAnomalies, ignoreAsteroidFields, techs.circletOfTheVoidActive, techs.canMoveThroughSupernova || techs.ignoreAllAnomalyEffects)) continue;
        const blockedByEnemyFleet =
          !techs.ignoreEnemyFleets && playersWithShipsInSystem(state, neighborId).some((p) => p !== playerId);
        if (blockedByEnemyFleet) continue;

        const entersNewRift = hasGravityRift(neighborAnomalies) && !techs.ignoreAllAnomalyEffects && !current.riftSystemsTouched.has(neighborId);
        const riftCount = current.riftCount + (entersNewRift ? 1 : 0);
        const riftSystemsTouched = entersNewRift ? new Set([...current.riftSystemsTouched, neighborId]) : current.riftSystemsTouched;
        const key = stateKey(neighborId, riftCount, passedThrough);
        const bestKnown = bestHopsForState.get(key);
        if (bestKnown !== undefined && bestKnown <= hops) continue;
        bestHopsForState.set(key, hops);
        nextFrontier.push({ systemId: neighborId, hops, riftCount, riftSystemsTouched, passedThrough });
      }
    }

    frontier = nextFrontier;
  }

  return false;
}

function stateKey(systemId: SystemId, riftCount: number, passedThrough: boolean): string {
  return `${systemId}|${riftCount}|${passedThrough ? 1 : 0}`;
}
