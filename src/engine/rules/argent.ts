import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asTechId } from "../types/ids";
import { SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { checkReinforcementsAvailable } from "./reinforcements";
import { playersWithShipsInSystem } from "./combat";
import { hasNebula, hasGravityRift } from "./anomalies";
import { maybeActivateWormholeNexus, getAdjacentSystems } from "./adjacency";
import { removeFromSystem, addToSystem } from "../phases/tacticalAction";

/**
 * The Argent Flight "ZEAL" (faction ability): "You always vote first
 * during the agenda phase." Confirmed (tirules2.com/F_argent): "always
 * votes first, EVEN IF they are the speaker" — meaning this overrides
 * the normal RR 8.2.ii "starts left of speaker, ends with speaker"
 * rotation entirely for Argent specifically; everyone else still votes
 * in that same normal rotated order afterward, just with Argent
 * removed from their own natural position and moved to the front. Used
 * by phases/agendaPhase.ts's own 2 votingOrder construction sites
 * (initial reveal, and Miscount Disclosed's own re-vote) instead of
 * duplicating this reordering logic in both places.
 */
export function applyZealVotingOrder(rotated: PlayerId[], players: GameState["players"]): PlayerId[] {
  const argentId = Object.values(players).find((p) => p.factionId === ("argent_flight" as never) && !p.eliminated)?.id;
  if (!argentId || !rotated.includes(argentId)) return rotated;
  return [argentId, ...rotated.filter((id) => id !== argentId)];
}

/**
 * The Argent Flight "ZEAL" (faction ability), 2nd half: "When you cast
 * at least 1 vote, cast 1 additional vote for each player in the game
 * including you." Confirmed (tirules2.com/F_argent): "additional votes
 * must be cast for the SAME outcome as the other votes" (automatic
 * here, since this is folded into the SAME CAST_VOTES call for one
 * outcome) and "if the Argent player abstains or otherwise casts zero
 * votes, they cannot cast additional votes" (checked via votes > 0,
 * using the count BEFORE this bonus). Applied in
 * phases/agendaPhase.ts's own castVotes, same shape as that function's
 * own Gila the Silvertongue/Predictive Intelligence bonuses.
 */
export function computeZealBonusVotes(state: GameState, playerId: PlayerId, votesBeforeBonus: number): number {
  const player = state.players[playerId];
  if (!player || player.factionId !== ("argent_flight" as never) || votesBeforeBonus <= 0) return 0;
  return Object.values(state.players).filter((p) => !p.eliminated).length;
}

/**
 * The Argent Flight "RAID FORMATION" (faction ability): resolving the
 * queued choice — see GameState.ts's own pendingRaidFormationChoice doc
 * comment and phases/spaceCombat.ts's own useAntiFighterBarrage for
 * where it gets queued. Confirmed (tirules2.com/F_argent): "the chosen
 * ship becomes damaged, it does NOT use its own Sustain Damage ability"
 * (so effects that trigger specifically "when a ship USES Sustain
 * Damage" — Direct Hit, Reflective Shielding — never fire from this);
 * "may choose an already-damaged ship, this will have no effect" (a
 * legal but wasted pick, not rejected); "Non-Euclidean Shielding
 * [Letnev tech] does not reduce the number of ships chosen" (i.e. that
 * tech's own "ignore the first hit assigned each combat" text doesn't
 * apply here at all, since these ships are never "assigned a hit" in
 * the normal sense — nothing to specially exempt, so no code needed);
 * "cannot be repaired by Empyrean's Dynamo" (not specifically enforced
 * here — Dynamo isn't built yet in this project, flagged rather than
 * silently assumed handled once it is).
 */
export function useRaidFormation(
  state: GameState,
  action: { type: "USE_RAID_FORMATION"; playerId: PlayerId; targetUnitTypes: import("../types/enums").UnitType[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  const choice = pending?.pendingRaidFormationChoice;
  if (!choice || choice.argentPlayerId !== action.playerId) return { ok: false, error: "No pending Raid Formation choice for this player." };
  if (action.targetUnitTypes.length !== choice.count) {
    return { ok: false, error: `Raid Formation: must choose exactly ${choice.count} ship(s).` };
  }

  const system = state.systems[choice.systemId];
  let stacks = (system.spaceUnitsByPlayer[choice.opponentId] ?? []).map((s) => ({ ...s }));
  for (const unitType of action.targetUnitTypes) {
    const stack = stacks.find((s) => s.unitType === unitType && s.count > 0);
    if (!stack) return { ok: false, error: `The opponent has no ${unitType} in ${choice.systemId}.` };
    const stats = getUnitStats(rules, state.players[choice.opponentId].factionId, unitType, state.players[choice.opponentId].unitUpgrades);
    if (!stats?.abilities.includes("sustainDamage")) return { ok: false, error: `Raid Formation: ${unitType} doesn't have Sustain Damage.` };
    // Confirmed: an already-damaged ship may still be chosen, with no further effect (never rejected, never double-damaged).
    if ((stack.damagedCount ?? 0) < stack.count) {
      stack.damagedCount = (stack.damagedCount ?? 0) + 1;
    }
  }
  stacks = stacks.filter((s) => s.count > 0);
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [choice.opponentId]: stacks } };
  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [choice.systemId]: updatedSystem }, pendingTacticalAction: { ...pending!, pendingRaidFormationChoice: undefined } },
    events: [],
  };
}

/**
 * The Argent Flight "Mirik Aun Sissiri — Helix Protocol" (hero): "ACTION:
 * Move any number of your ships from any systems to any number of other
 * systems that contain 1 of your command tokens and no other players'
 * ships. Then, purge this card." Confirmed (tirules2.com/F_argent):
 *  1. "Fighters may be moved without being transported" — an exception
 *     to the normal "fighters need a capacity-carrying ship" rule,
 *     modeled by simply never checking capacity for this action at all
 *     (matching the confirmed lack of any capacity-limit note for this
 *     ability — capacity is still checked normally by whatever OTHER
 *     action happens after this one, if it leaves cargo stranded).
 *  2. "Ships in systems with one of the Argent player's command tokens
 *     may move" — i.e. NO system activation is needed at all; ANY
 *     origin is legal (this project's own MOVE_SHIPS requires an
 *     active/activated system — Helix Protocol bypasses that whole
 *     requirement by design, hence being modeled as its own standalone
 *     action rather than a variant call into moveShips).
 *  3. "Ships may transport units only if their origin does NOT contain
 *     one of the Argent player's command tokens" — the one meaningful
 *     restriction on an otherwise very permissive move; enforced below
 *     per transported-cargo entry.
 *  4. "Ships move directly to their destination system... may only
 *     transport units from their origin system" — no intermediate hops
 *     modeled at all (unlike normal movement's adjacency pathfinding),
 *     so only the origin's and destination's own anomaly status matter.
 *  5. "Ships moving out of a gravity rift must roll for removal" — same
 *     trusted-RNG die-roll requirement as normal movement's own
 *     gravityRiftDieRolls.
 *  6. "Ships cannot move into a nebula or supernova, even if it
 *     contains one of the Argent player's command tokens" — CORRECTED
 *     scope: stricter than normal movement (which normally allows
 *     entering a nebula/supernova as an ACTIVE/destination system, just
 *     with consequences) — Helix Protocol blocks both OUTRIGHT as a
 *     destination, so this does NOT reuse canShipEnterTile's own
 *     isActiveSystem carve-out. "May travel into an asteroid field only
 *     with Antimass Deflectors" — same as normal movement.
 *  7. "May be used to move ships into the wormhole nexus. If the nexus
 *     is inactive, this will cause it to activate" — same
 *     maybeActivateWormholeNexus this project's own MOVE_SHIPS already
 *     calls elsewhere.
 */
export function useHelixProtocol(
  state: GameState,
  action: {
    type: "USE_HELIX_PROTOCOL";
    playerId: PlayerId;
    moves: { fromSystemId: SystemId; toSystemId: SystemId; unitType: import("../types/enums").UnitType; count: number }[];
    transportedGroundForces?: { fromSystemId: SystemId; toSystemId: SystemId; unitType: "infantry" | "mech"; count: number }[];
    transportedFighters?: { fromSystemId: SystemId; toSystemId: SystemId; count: number }[];
    gravityRiftDieRolls?: { fromSystemId: SystemId; unitType: import("../types/enums").UnitType; rolls: number[] }[];
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player?.leaders.find((l) => l.leaderId === ("argent_flight_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Mirik Aun Sissiri." };
  const hasAntimassDeflectors = player.technologies.includes(asTechId("antimass_deflectors"));

  const destinationsUsed = new Set<SystemId>();
  for (const move of action.moves) {
    destinationsUsed.add(move.toSystemId);
  }
  for (const g of action.transportedGroundForces ?? []) destinationsUsed.add(g.toSystemId);
  for (const f of action.transportedFighters ?? []) destinationsUsed.add(f.toSystemId);

  for (const destId of destinationsUsed) {
    if (!player.commandTokens.onBoard.includes(destId)) {
      return { ok: false, error: `Helix Protocol: ${destId} doesn't contain this player's own command token.` };
    }
    if (playersWithShipsInSystem(state, destId).some((id) => id !== action.playerId)) {
      return { ok: false, error: `Helix Protocol: ${destId} contains another player's ships.` };
    }
    const destAnomalies = state.systems[destId]?.anomalies ?? [];
    if (hasNebula(destAnomalies) || destAnomalies.includes("supernova" as never)) {
      return { ok: false, error: `Helix Protocol: cannot move into ${destId} — nebulae and supernovas are never valid destinations for this ability.` };
    }
    if (destAnomalies.includes("asteroidField" as never) && !hasAntimassDeflectors) {
      return { ok: false, error: `Helix Protocol: ${destId} is an asteroid field — this player needs Antimass Deflectors to move there.` };
    }
  }

  let nextState = state;
  const riftDestroyedIndices = new Map<string, Set<number>>();
  for (const move of action.moves) {
    const originAnomalies = nextState.systems[move.fromSystemId]?.anomalies ?? [];
    if (hasGravityRift(originAnomalies)) {
      const rollEntry = action.gravityRiftDieRolls?.find((r) => r.fromSystemId === move.fromSystemId && r.unitType === move.unitType);
      if (!rollEntry || rollEntry.rolls.length !== move.count) {
        return { ok: false, error: `Helix Protocol: ${move.fromSystemId} contains a gravity rift — need exactly ${move.count} gravityRiftDieRolls for this player's ${move.unitType} there.` };
      }
      const destroyed = new Set<number>();
      rollEntry.rolls.forEach((roll, i) => {
        if (roll <= 3) destroyed.add(i);
      });
      riftDestroyedIndices.set(`${move.fromSystemId}::${move.unitType}`, destroyed);
    }

    const originStack = (nextState.systems[move.fromSystemId]?.spaceUnitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === move.unitType && s.count > 0);
    if (!originStack || originStack.count < move.count) {
      return { ok: false, error: `Not enough ${move.unitType} in ${move.fromSystemId} to move ${move.count}.` };
    }
    nextState = removeFromSystem(nextState, move.fromSystemId, action.playerId, move.unitType, move.count);
    const survivors = move.count - (riftDestroyedIndices.get(`${move.fromSystemId}::${move.unitType}`)?.size ?? 0);
    if (survivors > 0) nextState = addToSystem(nextState, move.toSystemId, action.playerId, move.unitType, survivors);
    nextState = maybeActivateWormholeNexus(nextState, rules, move.toSystemId);
  }

  for (const g of action.transportedGroundForces ?? []) {
    if (nextState.players[action.playerId].commandTokens.onBoard.includes(g.fromSystemId)) {
      return { ok: false, error: `Helix Protocol: cannot transport units from ${g.fromSystemId} — it contains this player's own command token.` };
    }
    const sourceStacks = nextState.systems[g.fromSystemId]?.spaceUnitsByPlayer[action.playerId] ?? [];
    const found = sourceStacks.find((s) => s.unitType === g.unitType && s.count >= g.count);
    if (!found) return { ok: false, error: `Not enough ${g.unitType} in ${g.fromSystemId}'s space area to transport ${g.count}.` };
    nextState = removeFromSystem(nextState, g.fromSystemId, action.playerId, g.unitType, g.count);
    nextState = addToSystem(nextState, g.toSystemId, action.playerId, g.unitType, g.count);
  }
  for (const f of action.transportedFighters ?? []) {
    if (nextState.players[action.playerId].commandTokens.onBoard.includes(f.fromSystemId)) {
      return { ok: false, error: `Helix Protocol: cannot transport units from ${f.fromSystemId} — it contains this player's own command token.` };
    }
    const sourceStacks = nextState.systems[f.fromSystemId]?.spaceUnitsByPlayer[action.playerId] ?? [];
    const found = sourceStacks.find((s) => s.unitType === "fighter" && s.count >= f.count);
    if (!found) return { ok: false, error: `Not enough fighters in ${f.fromSystemId}'s space area to transport ${f.count}.` };
    nextState = removeFromSystem(nextState, f.fromSystemId, action.playerId, "fighter", f.count);
    nextState = addToSystem(nextState, f.toSystemId, action.playerId, "fighter", f.count);
  }

  const updatedPlayer: Player = { ...nextState.players[action.playerId], leaders: nextState.players[action.playerId].leaders.filter((l) => l.leaderId !== ("argent_flight_hero" as never)) };
  return { ok: true, state: { ...nextState, players: { ...nextState.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * The Argent Flight "Wing Transfer" (Breakthrough ability), placement
 * half: "When you activate a system that contains only your units, you
 * may place command tokens from your reinforcements into any system
 * adjacent to that system that contains only your units." Confirmed
 * (tirules2.com/F_argent) via this card's own FAQ note about the
 * SEPARATE movement half below — this placement half itself has no
 * additional FAQ nuance beyond its own printed text. One token per
 * chosen adjacent system, from reinforcements (checked via the same
 * 16-token personal supply cap this project already enforces
 * elsewhere), each validated to actually contain ONLY this player's own
 * units (or be genuinely empty) and be truly adjacent to the just-
 * activated system.
 */
export function usePlaceWingTransferTokens(
  state: GameState,
  action: { type: "USE_PLACE_WING_TRANSFER_TOKENS"; playerId: PlayerId; targetSystemIds: SystemId[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("argent_flight" as never) || !player.hasBreakthrough) {
    return { ok: false, error: "This player doesn't have Wing Transfer." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) return { ok: false, error: "Wing Transfer: no tactical action in progress for this player." };
  const activeSystem = state.systems[pending.systemId];
  const activeHasOnlyOwnUnits =
    Object.entries(activeSystem?.spaceUnitsByPlayer ?? {}).every(([pid, stacks]) => pid === action.playerId || (stacks ?? []).every((s) => s.count === 0)) &&
    activeSystem?.planets.every((p) => Object.entries(p.unitsByPlayer).every(([pid, stacks]) => pid === action.playerId || (stacks ?? []).every((s) => s.count === 0)));
  if (!activeHasOnlyOwnUnits) return { ok: false, error: "Wing Transfer: the activated system doesn't contain only this player's own units." };

  const adjacentIds = getAdjacentSystems(state, pending.systemId, rules, action.playerId);
  let nextState = state;
  for (const targetId of action.targetSystemIds) {
    if (!adjacentIds.includes(targetId)) return { ok: false, error: `Wing Transfer: ${targetId} isn't adjacent to ${pending.systemId}.` };
    const targetSystem = nextState.systems[targetId];
    const targetHasOnlyOwnUnits =
      Object.entries(targetSystem?.spaceUnitsByPlayer ?? {}).every(([pid, stacks]) => pid === action.playerId || (stacks ?? []).every((s) => s.count === 0)) &&
      targetSystem?.planets.every((p) => Object.entries(p.unitsByPlayer).every(([pid, stacks]) => pid === action.playerId || (stacks ?? []).every((s) => s.count === 0)));
    if (!targetHasOnlyOwnUnits) return { ok: false, error: `Wing Transfer: ${targetId} contains another player's units.` };
    const currentPlayer = nextState.players[action.playerId];
    const totalTokens = currentPlayer.commandTokens.tactic + currentPlayer.commandTokens.fleet + currentPlayer.commandTokens.strategy + currentPlayer.commandTokens.onBoard.length;
    if (totalTokens >= 16) return { ok: false, error: "RR: this player's personal command-token supply (16) is exhausted." };
    nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: { ...currentPlayer, commandTokens: { ...currentPlayer.commandTokens, onBoard: [...currentPlayer.commandTokens.onBoard, targetId] } } } };
  }

  return { ok: true, state: nextState, events: [] };
}

/**
 * The Argent Flight "Wing Transfer" (Breakthrough ability), movement
 * half: "At the end of this action, you may move ships among the active
 * system and systems adjacent to it that contain your command tokens."
 * Confirmed (tirules2.com/F_argent): "if the Argent player produces
 * units on their turn in the active system, they will have to satisfy
 * fleet pool and capacity limits there BEFORE they may move units to
 * adjacent systems" — this project's own normal fleet-pool/capacity
 * checks (rules/reinforcements.ts's own checkReinforcementsAvailable
 * doesn't cover this, but phases/tacticalAction.ts's own moveShips
 * already validates both) are reused directly by modeling this as
 * simple direct moves rather than duplicating that validation here —
 * this function only handles the eligibility (which systems qualify)
 * and the actual unit relocation, letting whatever calls it separately
 * confirm fleet pool/capacity same as any other move would.
 */
export function useWingTransferMove(
  state: GameState,
  action: { type: "USE_WING_TRANSFER_MOVE"; playerId: PlayerId; fromSystemId: SystemId; toSystemId: SystemId; unitType: import("../types/enums").UnitType; count: number },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("argent_flight" as never) || !player.hasBreakthrough) {
    return { ok: false, error: "This player doesn't have Wing Transfer." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "production") {
    return { ok: false, error: "Wing Transfer's own movement half is only usable at the end of this tactical action (the production step)." };
  }
  const eligibleSystemIds = new Set([pending.systemId, ...getAdjacentSystems(state, pending.systemId, rules, action.playerId).filter((id) => player.commandTokens.onBoard.includes(id))]);
  if (!eligibleSystemIds.has(action.fromSystemId) || !eligibleSystemIds.has(action.toSystemId)) {
    return { ok: false, error: "Wing Transfer: both systems must be the active system or an adjacent system containing this player's own command token." };
  }
  const sourceStack = (state.systems[action.fromSystemId]?.spaceUnitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === action.unitType && s.count >= action.count);
  if (!sourceStack) return { ok: false, error: `Not enough ${action.unitType} in ${action.fromSystemId} to move ${action.count}.` };

  let nextState = removeFromSystem(state, action.fromSystemId, action.playerId, action.unitType, action.count);
  nextState = addToSystem(nextState, action.toSystemId, action.playerId, action.unitType, action.count);
  return { ok: true, state: nextState, events: [] };
}
