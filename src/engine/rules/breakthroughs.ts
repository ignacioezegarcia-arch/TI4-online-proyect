import { GameState, Player } from "../types/GameState";
import { GameEvent } from "../types/Actions";
import { PlayerId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { setUpFractureOnEntry } from "../phases/theFracture";

/**
 * TE Breakthroughs (yjmrobert.com/tirules/rules/r_breakthroughs, TE
 * rulebook p.8): the ONE generic function that grants a player their
 * faction's breakthrough, regardless of what specific game action
 * triggered it (claiming a Thunder's Edge expedition slice, a faction-
 * specific ability, or being granted automatically during setup). What
 * a SPECIFIC faction's breakthrough actually DOES once gained (Data
 * Skimmer's own action-card-siphoning, Resonance Generator's own move
 * bonus, etc.) is deliberately NOT handled here — that's faction-
 * specific logic for a later pass, same scope split this project
 * already uses for Agents/Commanders/Heroes and Mechs (data now,
 * engine hooks per-faction later).
 *
 * This function only ever handles the 2 things EVERY breakthrough does,
 * no matter whose it is:
 *   1. Flip Player.hasBreakthrough on (idempotent — a no-op if already
 *      true), which is what actually activates that faction's own
 *      Synergy pair (see rules/RuleData.ts's own factions[].
 *      breakthroughSynergy, read by phases/technology.ts's own
 *      checkTechPrerequisites) — Synergy exists in RuleData from the
 *      start for every faction that has one, but doesn't COUNT until
 *      the breakthrough is actually earned.
 *   2. Roll to bring The Fracture into play, if it isn't already —
 *      confirmed to happen on EVERY single breakthrough grant across
 *      every faction, "regardless of source", not just the first one
 *      overall.
 */
export function grantBreakthrough(state: GameState, playerId: PlayerId, rules: RuleData, dieRoll?: number): { state: GameState; events: GameEvent[] } {
  const player = state.players[playerId];
  if (!player) return { state, events: [] };

  const events: GameEvent[] = [];
  let nextState = state;
  if (!player.hasBreakthrough) {
    const updatedPlayer: Player = { ...player, hasBreakthrough: true };
    nextState = { ...nextState, players: { ...nextState.players, [playerId]: updatedPlayer } };
    events.push({ type: "BREAKTHROUGH_GAINED", playerId });
  }

  if (!nextState.fractureInPlay) {
    // Trusted-RNG convention this project uses for every other dice roll
    // (RESOLVE_COMBAT_ROUND, BOMBARD, etc.) — the die is rolled by
    // whatever's calling this (bot/UI), not generated inside this pure
    // function. If the caller genuinely can't supply one yet (e.g. some
    // future automated setup path), this just skips the roll rather than
    // guessing a result — the fracture simply isn't triggered THIS time,
    // consistent with "never invent a die result".
    if (dieRoll !== undefined) {
      if (dieRoll === 1 || dieRoll === 10) {
        nextState = { ...nextState, fractureInPlay: true };
        events.push({ type: "FRACTURE_ENTERED_PLAY", triggeredByPlayerId: playerId });
        const setup = setUpFractureOnEntry(nextState, rules, playerId);
        nextState = setup.state;
        events.push(...setup.events);
      }
    }
  }

  return { state: nextState, events };
}
