import { GameState, Player } from "../types/GameState";
import { PlayerId, AgendaId } from "../types/ids";
import { isLawActiveWithOutcome } from "../phases/agendaEffects";

/**
 * RR 20: shared logic for placing NEWLY GAINED command tokens into
 * whichever of a player's 3 pools they choose — confirmed, this is true
 * for every source of new tokens in the full game (RR 70.5's status-phase
 * gain is the only source this engine currently implements and queues via
 * GameState.pendingCommandTokenGains, but any future source should reuse
 * this same validate+place function rather than re-deriving the RR
 * "Fleet Regulations" cap check on its own).
 */

/** Validates and applies placing `count` newly-gained command tokens across this player's 3 pools, split however the player likes. Returns an error if the counts don't sum to `count`, or if RR "Fleet Regulations" is active and the resulting fleet pool would exceed 4. */
export function placeGainedCommandTokens(
  state: GameState,
  player: Player,
  count: number,
  placement: { tactic: number; fleet: number; strategy: number },
): { ok: true; player: Player } | { ok: false; error: string } {
  if (placement.tactic < 0 || placement.fleet < 0 || placement.strategy < 0) {
    return { ok: false, error: "Command token counts can't be negative." };
  }
  const total = placement.tactic + placement.fleet + placement.strategy;
  if (total !== count) {
    return { ok: false, error: `RR 20: must place exactly ${count} newly-gained command token(s) total, got ${total}.` };
  }

  const newFleetTotal = player.commandTokens.fleet + placement.fleet;
  if (newFleetTotal > 4 && isLawActiveWithOutcome(state, "fleet_regulations" as AgendaId, "for")) {
    return { ok: false, error: 'RR "Fleet Regulations": a player\'s fleet pool cannot exceed 4 command tokens while this law is active.' };
  }

  return {
    ok: true,
    player: {
      ...player,
      commandTokens: {
        ...player.commandTokens,
        tactic: player.commandTokens.tactic + placement.tactic,
        fleet: newFleetTotal,
        strategy: player.commandTokens.strategy + placement.strategy,
      },
    },
  };
}
