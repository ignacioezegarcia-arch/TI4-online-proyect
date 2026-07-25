import { GameState, PendingPriorityWindow } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId } from "../types/ids";

/**
 * RR 1.19/1.20 priority windows — see GameState.ts's own PendingPriorityWindow
 * doc comment for the full mechanic. This file only has the generic
 * open/check/advance/close machinery. It is deliberately NOT specific to
 * action cards — `kind` identifies the game MOMENT a window opens for
 * (an agenda being revealed, a combat round starting, an invasion
 * starting), never what's resolving during it. A not-yet-built faction
 * ability, relic, or leader ability that triggers at one of these same
 * moments plugs in exactly the same way any action card here does: check
 * isPlayersTurnInWindow(state, <kind>, playerId) before resolving, call
 * advancePriorityWindowAfterAction(state, playerId) after. Adding a
 * genuinely NEW trigger moment this project doesn't have yet (e.g. "at
 * the start of your turn", "when you gain control of a planet") is a
 * small, additive extension — 1 new string in PendingPriorityWindow's own
 * `kind` union, a way to compute that moment's own `order` (reusing
 * actionPhaseWindowOrder/agendaPhaseWindowOrder below as building blocks
 * — most moments are one or the other), and opening it at the right spot
 * in whichever phase file the moment actually occurs in — not a redesign
 * of this file.
 *
 * Currently used by (phases/actionCardEffects.ts): the 8 rider functions
 * + PLAY_ASSASSINATE_REPRESENTATIVE/PLAY_VETO/PLAY_HACK_ELECTION/PLAY_
 * INSIDER_INFORMATION/PLAY_DIPLOMATIC_PRESSURE/PLAY_SANCTION for
 * "agenda_revealed"; PLAY_MORALE_BOOST/PLAY_SKILLED_RETREAT for
 * "combat_round_start"; PLAY_BUNKER/PLAY_BLITZ for "invasion_start" (the
 * latter 2 kinds' own window-OPENING call sites in spaceCombat.ts/
 * invasion.ts are still pending — see this project's own notes on that).
 *
 * NOT every reactive-timing action card goes through this. The 5 "after
 * YOU activate a system" cards (Flank Speed, In the Silence of Space,
 * Lost Star Chart, Solar Flare, Nav Suite) don't — that timing phrase
 * always refers to the card OWNER's own activation, so there is never
 * another player with standing to contest that exact window; opening a
 * whole priority round for an audience of 1 would be pure overhead with
 * no rules content behind it. The same reasoning will apply to some
 * future faction/relic/leader abilities too (anything phrased as "your
 * own X" with no possible other claimant).
 */

/** RR 1.19: action-phase ordering — starts with the active player, then continues in initiative order, filtered down to only the players who could plausibly act in THIS specific window (e.g. just the 2 combatants in a fight, not the whole table). */
export function actionPhaseWindowOrder(state: GameState, activePlayerId: PlayerId, participantIds: PlayerId[]): PlayerId[] {
  const idx = state.initiativeOrder.indexOf(activePlayerId);
  const rotated = idx === -1 ? state.initiativeOrder : [...state.initiativeOrder.slice(idx), ...state.initiativeOrder.slice(0, idx)];
  const participantSet = new Set(participantIds);
  return rotated.filter((id) => participantSet.has(id));
}

/** RR 1.20: strategy/agenda-phase ordering — starts WITH the speaker (unlike RR 8.2.ii's own voting order, which explicitly starts to the speaker's LEFT and votes the speaker last — a different order for a different purpose), then continues in seat order. */
export function agendaPhaseWindowOrder(state: GameState): PlayerId[] {
  const speakerId = state.seatOrder.find((id) => state.players[id]?.isSpeaker);
  if (!speakerId) return state.seatOrder;
  const speakerIndex = state.seatOrder.indexOf(speakerId);
  return [...state.seatOrder.slice(speakerIndex), ...state.seatOrder.slice(0, speakerIndex)];
}

/** Opens a new window — fails loudly (rather than silently overwriting) if one is somehow already open, since that would mean 2 unrelated windows got tangled together. */
export function openPriorityWindow(state: GameState, kind: PendingPriorityWindow["kind"], order: PlayerId[]): GameState {
  if (state.pendingPriorityWindow) {
    throw new Error(`Tried to open a "${kind}" priority window while a "${state.pendingPriorityWindow.kind}" one is still open.`);
  }
  if (order.length === 0) return state;
  return { ...state, pendingPriorityWindow: { kind, order, currentIndex: 0, consecutivePasses: 0 } };
}

/** True if it's currently `playerId`'s turn in an open window of this `kind` — every reactive card function that goes through this system checks this FIRST, before any of its own card-specific legality checks. */
export function isPlayersTurnInWindow(state: GameState, kind: PendingPriorityWindow["kind"], playerId: PlayerId): boolean {
  const window = state.pendingPriorityWindow;
  return Boolean(window && window.kind === kind && window.order[window.currentIndex] === playerId);
}

/** Called by every reactive card's own play-function AFTER it successfully resolves — RR 1.19: playing something resets the consecutive-pass count to 0 and moves on to the NEXT player after the actor (continuing the rotation, not restarting it), so a player who already passed earlier in this same window can still get another turn later. */
export function advancePriorityWindowAfterAction(state: GameState, playerId: PlayerId): GameState {
  const window = state.pendingPriorityWindow;
  if (!window) return state;
  const actorIndex = window.order.indexOf(playerId);
  const nextIndex = actorIndex === -1 ? window.currentIndex : (actorIndex + 1) % window.order.length;
  return { ...state, pendingPriorityWindow: { ...window, currentIndex: nextIndex, consecutivePasses: 0 } };
}

/** RR 1.16: "when" effects resolve before "after" effects for the SAME event — some window pairs are therefore sequential rather than simultaneous: the first fully closes (every participant consecutively passes) before the second opens, for the exact same participants. Purely mechanical chaining, encoded here since it's a fixed consequence of RR 1.16 itself, not specific to any card/ability. */
const CHAINED_NEXT_KIND: Partial<Record<PendingPriorityWindow["kind"], PendingPriorityWindow["kind"]>> = {
  system_activated: "after_system_activated",
};

/** RR 1.19: "Once every player has consecutively declined to resolve an ability during a timing window, no more abilities may be resolved during that window." The generic PASS_PRIORITY action — legal any time it's this player's turn in ANY open window, regardless of `kind` (the caller doesn't need to know which one is open to pass on it). */
export function passPriority(state: GameState, action: { type: "PASS_PRIORITY"; playerId: PlayerId }): ActionResult {
  const window = state.pendingPriorityWindow;
  if (!window) return { ok: false, error: "No priority window is currently open." };
  if (window.order[window.currentIndex] !== action.playerId) {
    return { ok: false, error: "It isn't this player's turn to act or pass in the current priority window." };
  }
  const consecutivePasses = window.consecutivePasses + 1;
  if (consecutivePasses >= window.order.length) {
    const nextKind = CHAINED_NEXT_KIND[window.kind];
    const pendingPriorityWindow = nextKind ? { kind: nextKind, order: window.order, currentIndex: 0, consecutivePasses: 0 } : null;
    return { ok: true, state: { ...state, pendingPriorityWindow }, events: [{ type: "PRIORITY_WINDOW_CLOSED", kind: window.kind }] };
  }
  const nextIndex = (window.currentIndex + 1) % window.order.length;
  return { ok: true, state: { ...state, pendingPriorityWindow: { ...window, currentIndex: nextIndex, consecutivePasses } }, events: [] };
}
