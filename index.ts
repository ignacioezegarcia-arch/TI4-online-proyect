// supabase/functions/apply-action/index.ts
//
// This is the sole authority for game state. The browser client runs the
// exact same GameEngine locally too (for instant UI feedback — see
// src/lib/applyAction.ts), but that local run is advisory only. Whatever
// this function computes and writes to `games.state` is what actually
// counts, because `games` has no client-writable RLS policy (0001_init.sql)
// — this function uses the service-role key, which is the only way in.
//
// Request body: { gameId: string, action: GameAction }
// Responses:
//   200 { ok: true, events: GameEvent[] }
//   400 { ok: false, error: string }   — illegal action per the rules
//   401 { ok: false, error: string }   — not authenticated
//   403 { ok: false, error: string }   — authenticated, but not this seat
//   404 { ok: false, error: string }   — game not found
//   409 { ok: false, error: "conflict", currentVersion }
//                                       — someone else's action landed first;
//                                         client should refetch and retry

import { corsHeaders } from "../_shared/cors.ts";
import { getAdminClient, getCallerClient } from "../_shared/supabaseClients.ts";
import { loadRuleData } from "../_shared/ruleData.ts";
import { GameEngine } from "../_shared/engine/GameEngine.ts";
import type { GameState } from "../_shared/engine/types/GameState.ts";
import type { GameAction } from "../_shared/engine/types/Actions.ts";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let payload: { gameId?: string; action?: GameAction };
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Malformed JSON body." }, 400);
  }

  const { gameId, action } = payload;
  if (!gameId || !action) {
    return json({ ok: false, error: "Body must include { gameId, action }." }, 400);
  }

  // --- 1. Who is actually calling this? ---------------------------------
  const callerClient = getCallerClient(req);
  const {
    data: { user },
    error: authError,
  } = await callerClient.auth.getUser();
  if (authError || !user) {
    return json({ ok: false, error: "Not authenticated." }, 401);
  }

  const admin = getAdminClient();

  // --- 2. Does this user actually control the seat the action claims? ---
  // This is the anti-cheat linchpin: `action.playerId` comes from the
  // client and cannot be trusted on its own — we cross-check it against
  // the game_players mapping row for *this authenticated user*.
  if ("playerId" in action) {
    const { data: seat, error: seatError } = await admin
      .from("game_players")
      .select("player_id")
      .eq("game_id", gameId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (seatError || !seat) {
      return json({ ok: false, error: "You are not a player in this game." }, 403);
    }
    if (seat.player_id !== action.playerId) {
      return json({ ok: false, error: `You control ${seat.player_id}, not ${action.playerId}.` }, 403);
    }
  }

  // --- 3. Load current state ---------------------------------------------
  const { data: game, error: gameError } = await admin
    .from("games")
    .select("state, version")
    .eq("id", gameId)
    .maybeSingle();

  if (gameError || !game) {
    return json({ ok: false, error: "Game not found." }, 404);
  }

  const state = game.state as GameState;
  const factionIds = Object.values(state.players).map((p) => p.factionId);
  const rules = await loadRuleData(factionIds);

  // --- 4. Run the same engine the client already ran optimistically -----
  const result = GameEngine.applyAction(state, action, rules);
  if (!result.ok || !result.state) {
    return json({ ok: false, error: result.error ?? "Illegal action." }, 400);
  }

  // --- 5. Write back, guarded by optimistic concurrency ------------------
  const newVersion = game.version + 1;
  const { data: updated, error: updateError } = await admin
    .from("games")
    .update({ state: result.state, version: newVersion, updated_at: new Date().toISOString() })
    .eq("id", gameId)
    .eq("version", game.version) // <-- the guard: fails silently (0 rows) if someone else already wrote
    .select("version");

  if (updateError) {
    return json({ ok: false, error: `Write failed: ${updateError.message}` }, 500);
  }
  if (!updated || updated.length === 0) {
    return json({ ok: false, error: "conflict", currentVersion: null }, 409);
  }

  if (result.events?.length) {
    await admin.from("game_events").insert(
      result.events.map((event) => ({ game_id: gameId, seq: newVersion, event })),
    );
  }

  return json({ ok: true, events: result.events ?? [] }, 200);
});
