// supabase/functions/_shared/supabaseClients.ts
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically into
// every Edge Function's environment by Supabase — you do not set these
// yourself in a .env for deployed functions (only for local `supabase
// functions serve`, if you want to test without Docker's auto-injection).
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Bypasses RLS entirely. This is the ONLY client allowed to write to
 * `games` and `game_events` (see 0001_init.sql — there's no `authenticated`
 * write policy on either table). Never send this client, or its key, to
 * the browser.
 */
export function getAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Scoped to whoever called the function, via the Authorization header
 * `supabase.functions.invoke()` attaches automatically on the client.
 * Used only to answer "who is actually making this request" — never to
 * write game state.
 */
export function getCallerClient(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
