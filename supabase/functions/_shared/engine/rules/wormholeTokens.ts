import { GameState } from "../types/GameState";
import { SystemId } from "../types/ids";

/**
 * The 3 GENERIC gamma wormhole tokens — physical game components
 * separate from Ghosts of Creuss's own faction-specific alpha/beta/
 * gamma set (rules/creuss.ts's own creussWormholeTokenLocations).
 * Confirmed sources (one token each, by the user directly): the
 * Cultural exploration card "Gamma Wormhole", the Frontier exploration
 * card "Gamma Relay", and the "Nexus Sovereignty" agenda's own
 * "against" outcome. Modeled as 3 distinct, stably-identified tokens
 * (GameState.genericGammaWormholeTokens) rather than a plain counter,
 * so each can eventually carry its own distinct visual/art identity.
 *
 * Each of the 3 sources is independently limited to using this ONLY
 * once already (a single-count, purged exploration card; a
 * single-resolution agenda outcome) — but this function ALSO enforces
 * the shared 3-token ceiling directly, rather than relying solely on
 * each caller's own natural limit, so the true physical constraint
 * holds even if some future source/edge case doesn't happen to be
 * self-limiting on its own.
 */
export function placeGenericGammaWormholeToken(state: GameState, systemId: SystemId): { ok: true; state: GameState } | { ok: false; error: string } {
  const targetSystem = state.systems[systemId];
  if (!targetSystem) return { ok: false, error: `No system ${systemId}.` };

  if (targetSystem.wormholes.includes("gamma")) {
    // Already has a gamma wormhole (e.g. the Wormhole Nexus, which starts with one printed) — no new token needed, matching the confirmed "no additional effect" behavior for targeting an already-gamma system.
    return { ok: true, state };
  }

  const availableToken = state.genericGammaWormholeTokens.find((t) => t.systemId === null);
  if (!availableToken) {
    return { ok: false, error: "No generic gamma wormhole tokens remaining — all 3 have already been placed." };
  }

  return {
    ok: true,
    state: {
      ...state,
      systems: { ...state.systems, [systemId]: { ...targetSystem, wormholes: [...targetSystem.wormholes, "gamma"] } },
      genericGammaWormholeTokens: state.genericGammaWormholeTokens.map((t) => (t.tokenId === availableToken.tokenId ? { ...t, systemId } : t)),
    },
  };
}
