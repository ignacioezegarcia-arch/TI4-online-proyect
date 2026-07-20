import { Player } from "../types/GameState";
import { LeaderId } from "../types/ids";

/**
 * RR "Leaders": shared plumbing for the 3-leader system (agent/commander/
 * hero) every faction has. Confirmed rules this project's own engine needs
 * to enforce generically:
 *  - AGENT: starts readied+unlocked. Exhausts to resolve its own ability
 *    (per-faction, not generalized here — see this project's own note on
 *    Deploy for why per-faction ability TEXT stays deferred while the
 *    surrounding mechanic gets built now). Readies during the status
 *    phase's "Ready Cards" step, same as strategy cards/planets/techs.
 *  - COMMANDER: starts locked. Unlocks permanently once its own
 *    (faction-specific) condition is met — that CHECK is deferred per-
 *    faction, same reasoning as Deploy; this file only provides the
 *    generic "flip it unlocked" setter once some other code determines
 *    the condition is met. Cannot be exhausted at all — a commander's
 *    ability is a passive, always-on effect once unlocked, never a
 *    resolve-and-exhaust one.
 *  - HERO: starts locked. Unlocks the moment a player has 3 scored
 *    objectives — confirmed, this ONE condition is universal across every
 *    faction (unlike commanders), so it's checked generically right here
 *    rather than deferred. Cannot be exhausted; used at most once per game,
 *    then purged (removed from Player.leaders entirely) — except Titans of
 *    Ul's hero, which attaches to a planet instead of being purged, a
 *    confirmed faction-specific exception not handled by this shared code.
 */

function findLeader(player: Player, leaderId: LeaderId) {
  return player.leaders.find((l) => l.leaderId === leaderId);
}

/** Does this player own this leader, is it unlocked (if it needs to be), and is it currently readied? */
export function canUseAgent(player: Player, leaderId: LeaderId): { ok: true } | { ok: false; error: string } {
  const leader = findLeader(player, leaderId);
  if (!leader) return { ok: false, error: `This player doesn't own leader ${leaderId}.` };
  if (leader.exhausted) return { ok: false, error: `${leaderId} is already exhausted.` };
  return { ok: true };
}

export function exhaustLeader(player: Player, leaderId: LeaderId): Player {
  return { ...player, leaders: player.leaders.map((l) => (l.leaderId === leaderId ? { ...l, exhausted: true } : l)) };
}

/** RR 70's own "Ready Cards" step: agents ready alongside everything else exhaustable. Commanders/heroes are never exhausted in the first place, so readying them is always a no-op — this just readies whatever's currently exhausted, safe to call on all 3 uniformly. */
export function readyAllLeaders(player: Player): Player {
  return { ...player, leaders: player.leaders.map((l) => ({ ...l, exhausted: false })) };
}

/** Is this specific commander currently unlocked? (Read-only check — the actual per-faction unlock CONDITION check is deferred, see this file's own header note.) */
export function isCommanderUnlocked(player: Player, leaderId: LeaderId): boolean {
  const leader = findLeader(player, leaderId);
  return Boolean(leader && !leader.locked);
}

/** Permanently flips this commander to unlocked — confirmed, this can never be reversed even if the player later stops meeting the condition. Whoever calls this is responsible for having already confirmed the (faction-specific) unlock condition is met. */
export function unlockCommander(player: Player, leaderId: LeaderId): Player {
  return { ...player, leaders: player.leaders.map((l) => (l.leaderId === leaderId ? { ...l, locked: false } : l)) };
}

/** RR "Leaders": every hero's own unlock condition is universally "3 scored objectives" — checks that against this player's OWN already-tracked victoryPoints.scoredObjectiveIds and flips the matching leader entry unlocked if it isn't already. Safe to call after any objective is scored; a no-op if the threshold isn't met yet or the hero's already unlocked. */
export function maybeUnlockHero(player: Player, leaderId: LeaderId): Player {
  const leader = findLeader(player, leaderId);
  if (!leader || !leader.locked) return player;
  if (player.victoryPoints.scoredObjectiveIds.length < 3) return player;
  return { ...player, leaders: player.leaders.map((l) => (l.leaderId === leaderId ? { ...l, locked: false } : l)) };
}

/** Is this specific hero currently unlocked? */
export function isHeroUnlocked(player: Player, leaderId: LeaderId): boolean {
  const leader = findLeader(player, leaderId);
  return Boolean(leader && !leader.locked);
}

/** RR "Leaders": after a hero's ability is resolved, it's purged (removed from Player.leaders entirely) — confirmed exception: Titans of Ul's hero attaches to Elysium instead, which per-faction code should handle by NOT calling this for that one specific hero. */
export function purgeHero(player: Player, leaderId: LeaderId): Player {
  return { ...player, leaders: player.leaders.filter((l) => l.leaderId !== leaderId) };
}
