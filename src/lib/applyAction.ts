// src/lib/applyAction.ts
import { SupabaseClient } from "@supabase/supabase-js";
import { GameEngine } from "../engine/GameEngine";
import { GameAction, ActionResult } from "../engine/types/Actions";
import { GameState } from "../engine/types/GameState";
import { loadRuleDataBrowser } from "./loadRuleDataBrowser";

export interface SubmitActionOutcome {
  /** Optimistic result the UI can render immediately, before the server confirms. */
  optimistic: ActionResult;
  /** Resolves once the Edge Function has authoritatively accepted or rejected the action.
   *  Realtime will also push the confirmed state — awaiting this is mainly useful for
   *  showing "still confirming..." UI or surfacing a rejection the optimistic run missed
   *  (e.g. someone else's action landed in between). */
  confirmed: Promise<{ ok: boolean; error?: string }>;
}

/**
 * Call this from a button handler. It does NOT wait for the network before
 * returning — render the `optimistic` result immediately, and treat
 * `confirmed` as a background reconciliation. If `confirmed` ever resolves
 * with `ok: false`, roll the optimistic UI change back and show the error;
 * this should be rare (it means the server saw something the client didn't,
 * e.g. another player's action changed what was legal).
 */
export function submitAction(
  supabase: SupabaseClient,
  gameId: string,
  currentState: GameState,
  action: GameAction,
): SubmitActionOutcome {
  const factionIds = Object.values(currentState.players).map((p) => p.factionId);
  const rules = loadRuleDataBrowser(factionIds);
  const optimistic = GameEngine.applyAction(currentState, action, rules);

  const confirmed = sendWithRetry(supabase, gameId, action);

  return { optimistic, confirmed };
}

async function sendWithRetry(
  supabase: SupabaseClient,
  gameId: string,
  action: GameAction,
  attemptsLeft = 3,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("apply-action", {
    body: { gameId, action },
  });

  if (!error) return { ok: true };

  // supabase-js surfaces non-2xx responses as `error`; the function's own
  // JSON body (with our `error` message) is on `error.context`.
  const status = (error as { context?: { status?: number } })?.context?.status;
  const message = (data as { error?: string } | null)?.error ?? error.message;

  if (status === 409 && attemptsLeft > 0) {
    // Someone else's action landed first. Their write already happened —
    // Realtime will (or just did) deliver the fresh state to this client;
    // the caller re-derives `currentState` from that and re-submits.
    // A tiny backoff avoids a tight retry loop if several clients collide.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return sendWithRetry(supabase, gameId, action, attemptsLeft - 1);
  }

  return { ok: false, error: message };
}
