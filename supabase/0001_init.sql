-- 0001_init.sql
--
-- The anti-cheat model in one sentence: authenticated players can READ
-- everything about a game they're in, but can only ever WRITE to `games`
-- and `game_events` through the `apply-action` Edge Function (which uses
-- the service-role key, bypassing RLS). There is deliberately no UPDATE
-- policy on `games` for the `authenticated` role — if that's ever missing,
-- a player could just PATCH their own game state directly from the browser
-- and win instantly.

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null check (mode in ('base', 'pok', 'pok_te')),
  victory_point_target smallint not null check (victory_point_target in (10, 14)),
  state jsonb not null,
  -- Optimistic concurrency: the Edge Function increments this on every
  -- successful write and only writes if the version it read hasn't moved.
  -- Prevents two near-simultaneous actions from silently clobbering each
  -- other (RR games are turn-based, but transactions/agenda votes can
  -- legitimately happen "at the same time" from the DB's point of view).
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists game_players (
  game_id uuid not null references games(id) on delete cascade,
  -- The PlayerId string used *inside* GameState (e.g. "p1") — this is the
  -- join between "which Supabase Auth user" and "which seat in the engine".
  player_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  seat_order smallint not null,
  primary key (game_id, player_id),
  unique (game_id, user_id)
);

create table if not exists game_events (
  id bigint generated always as identity primary key,
  game_id uuid not null references games(id) on delete cascade,
  seq integer not null, -- monotonic per game, mirrors GameState.round/order of application
  event jsonb not null,
  created_at timestamptz not null default now()
);

alter table games enable row level security;
alter table game_players enable row level security;
alter table game_events enable row level security;

-- Anyone in the game can read the current state (Realtime subscribes through this).
create policy "players can read their games"
  on games for select
  using (
    exists (
      select 1 from game_players gp
      where gp.game_id = games.id and gp.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for `authenticated` on `games` — intentional.
-- Only the service role (used inside the Edge Function) can write here.

create policy "players can read their own seat mappings"
  on game_players for select
  using (
    exists (
      select 1 from game_players gp2
      where gp2.game_id = game_players.game_id and gp2.user_id = auth.uid()
    )
  );

create policy "players can read their game's event log"
  on game_events for select
  using (
    exists (
      select 1 from game_players gp
      where gp.game_id = game_events.game_id and gp.user_id = auth.uid()
    )
  );

-- Same reasoning as `games`: no direct insert policy for `authenticated` on
-- `game_events` — only the Edge Function (service role) appends events, so
-- the log can't be forged or tampered with from the client either.
