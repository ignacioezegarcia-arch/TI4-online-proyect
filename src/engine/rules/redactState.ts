import { GameState, Player } from "../types/GameState";
import { PlayerId } from "../types/ids";

/**
 * Produces a copy of `state` safe to send to `viewerId` specifically.
 *
 * HIDDEN (redacted below): every deck's own ORDER and CONTENTS — agenda,
 * action card, secret objective, the 4 exploration decks, relic, and the
 * 2 public objective stages — plus every OTHER player's own hidden hand
 * (action cards in hand, unscored secret objectives, promissory notes in
 * hand).
 *
 * STAYS PUBLIC (untouched below, confirmed against RR): every discard
 * pile (agenda/action card/exploration x4), board state (units, planet
 * control, systems), command token pool counts, trade goods, laws in
 * play, already-scored objectives, promissory notes already placed
 * face-up (`promissoryNotesInPlayArea` — RR: these stop being tradeable
 * and sit face-up once received), leaders, relics owned, captured units,
 * and rider predictions (`pendingAgendaVote.predictions` — RR: predicted
 * "aloud", i.e. public the moment it's made, not hidden information at
 * all).
 *
 * Deliberately keeps the EXACT SAME GameState shape (redacted arrays are
 * the same LENGTH as the real ones, just filled with a placeholder id)
 * instead of introducing a parallel "RedactedGameState" type — a client
 * that only needs `.length` for a deck it can't see (e.g. "12 cards
 * remain") works fine either way, and this way every existing GameState
 * consumer in the engine keeps compiling completely unchanged; nothing
 * has to import a new type just to pass a redacted copy through.
 *
 * NOT YET WIRED to any live distribution path. Checked: this project has
 * no Realtime sync layer built yet (no client-side postgres_changes or
 * Broadcast subscription exists anywhere in src/, as of this writing —
 * src/lib/applyAction.ts only submits actions and runs the same engine
 * locally for instant advisory feedback, it doesn't subscribe to
 * anything). Whatever eventually pushes `games.state` to connected
 * clients needs to call this once PER connected player and send each
 * their own copy — critically, that means a shared `postgres_changes`
 * subscription on the raw `games` table (Supabase's default Realtime
 * pattern) is the WRONG mechanism no matter what, since Postgres has no
 * concept of "redact this jsonb column differently per subscriber" — it
 * would broadcast the single unredacted row to everyone regardless of
 * this function's existence. The right shape is a per-player Realtime
 * Broadcast channel (or an authenticated per-player REST fetch), with
 * whatever writes `games.state` (supabase/functions/apply-action today)
 * computing 1 redacted payload per seat and sending each to only that
 * seat's own channel/response.
 */
export function redactStateForPlayer(state: GameState, viewerId: PlayerId): GameState {
  const players: Record<PlayerId, Player> = {};
  for (const [id, player] of Object.entries(state.players)) {
    const pid = id as PlayerId;
    if (pid === viewerId) {
      players[pid] = player;
      continue;
    }
    players[pid] = {
      ...player,
      actionCards: redactedCopy(player.actionCards),
      secretObjectives: redactedCopy(player.secretObjectives),
      promissoryNotesInHand: redactedCopy(player.promissoryNotesInHand),
    };
  }

  return {
    ...state,
    players,
    agendaDeck: { ...state.agendaDeck, deckIds: redactedCopy(state.agendaDeck.deckIds) },
    actionCardDeck: state.actionCardDeck ? redactedCopy(state.actionCardDeck) : state.actionCardDeck,
    secretObjectiveDeck: state.secretObjectiveDeck ? redactedCopy(state.secretObjectiveDeck) : state.secretObjectiveDeck,
    publicObjectiveDeck: state.publicObjectiveDeck
      ? { stageI: redactedCopy(state.publicObjectiveDeck.stageI), stageII: redactedCopy(state.publicObjectiveDeck.stageII) }
      : state.publicObjectiveDeck,
    explorationDecks: state.explorationDecks
      ? {
          cultural: redactedCopy(state.explorationDecks.cultural),
          industrial: redactedCopy(state.explorationDecks.industrial),
          hazardous: redactedCopy(state.explorationDecks.hazardous),
          frontier: redactedCopy(state.explorationDecks.frontier),
        }
      : state.explorationDecks,
    relicDeck: state.relicDeck ? redactedCopy(state.relicDeck) : state.relicDeck,
  };
}

/** Never a real id in any data/*.json file — if a client ever renders this literally instead of just using array length, that's a sign it's trying to display something it was never supposed to see the identity of. */
const REDACTED_PLACEHOLDER = "\u25A0hidden\u25A0";

function redactedCopy<T extends string>(ids: T[]): T[] {
  return ids.map(() => REDACTED_PLACEHOLDER) as T[];
}
