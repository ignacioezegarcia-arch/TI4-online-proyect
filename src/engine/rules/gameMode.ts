import { GameMode } from "../types/enums";

/**
 * Shared checks for GameMode — every PoK-gate/Codex-gate/Thunder's-Edge-gate
 * elsewhere in this engine should call these instead of comparing against
 * the raw "base"/"pok_codex"/"pok_codex_te"/"te" strings directly, so this
 * file is the ONE place that needs updating if the supported mode list
 * ever grows past today's confirmed 4 combinations (see enums.ts's own
 * doc comment on GameMode).
 */

/** True for "pok_codex" and "pok_codex_te" — false for "base" and "te" (Codex is always bundled with PoK, never available standalone, per this project's own confirmed scope). */
export function hasPoKContent(mode: GameMode): boolean {
  return mode === "pok_codex" || mode === "pok_codex_te";
}

/** Alias for hasPoKContent — Codex is never optional-without-PoK or available-without-PoK, so "does this game have Codex updates active" and "does this game have PoK content" are the exact same question today. Kept as its own named function anyway so call sites read clearly for what they're actually checking (e.g. "which tech version applies" reads better against hasCodex than hasPoKContent). */
export function hasCodex(mode: GameMode): boolean {
  return hasPoKContent(mode);
}

/** True for "pok_codex_te" and "te" — false for "base" and "pok_codex". */
export function hasThundersEdge(mode: GameMode): boolean {
  return mode === "pok_codex_te" || mode === "te";
}

/**
 * A few technologies (Magen Defense Grid, X-89 Bacterial Weapon) have been
 * re-worked by Codex updates into a materially different mechanic — not
 * just a numbers tweak. Since the latest Codex (4, "ΩΩ") supersedes the
 * earlier one (1, "Ω") whenever ANY Codex-updated ruleset is in play, and
 * — confirmed — Thunder's Edge (played standalone or with PoK+Codex)
 * ALSO uses the ΩΩ version by default, there are only ever 2 versions
 * actually reachable in play: the base one (only in plain "base" games)
 * and ΩΩ (everywhere else). Never the Ω-only middle one. Call sites for
 * these specific techs branch on this instead of re-deriving the same
 * "mode !== base" check inline everywhere.
 */
export function usesCodex4Version(mode: GameMode): boolean {
  return mode !== "base";
}
