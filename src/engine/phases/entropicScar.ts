import { GameState, Player } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, TechId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { hasEntropicScar } from "../rules/anomalies";

/**
 * TE ENTROPIC SCAR (rulebook p.11): "At the start of the status phase, a
 * player that has ships in an entropic scar can spend a token from their
 * strategy pool to gain one of their faction-specific technologies."
 *
 * "Gain" (not "research") — bypasses prerequisites entirely, same
 * distinction this project already applies consistently elsewhere (e.g.
 * Divert Funding's own researched-vs-returned tech handling).
 */
export function gainFactionTechViaEntropicScar(
  state: GameState,
  action: { type: "GAIN_FACTION_TECH_VIA_ENTROPIC_SCAR"; playerId: PlayerId; techId: TechId },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "status") {
    return { ok: false, error: "TE ENTROPIC SCAR: only usable during the status phase." };
  }
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.commandTokens.strategy < 1) {
    return { ok: false, error: "TE ENTROPIC SCAR: no command token in this player's strategy pool to spend." };
  }
  const hasShipsInScar = Object.values(state.systems).some(
    (sys) => hasEntropicScar(sys.anomalies) && (sys.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0),
  );
  if (!hasShipsInScar) {
    return { ok: false, error: "TE ENTROPIC SCAR: this player has no ships in an entropic scar." };
  }
  const factionTechs = rules.factionTechIdsByFaction[player.factionId] ?? [];
  if (!factionTechs.includes(action.techId)) {
    return { ok: false, error: "TE ENTROPIC SCAR: that isn't one of this player's own faction-specific technologies." };
  }
  if (player.technologies.includes(action.techId)) {
    return { ok: false, error: "This player already owns that technology." };
  }

  const updatedPlayer: Player = {
    ...player,
    commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 },
    technologies: [...player.technologies, action.techId],
  };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [],
  };
}
