import { PlayerId, FactionId, PromissoryNoteId, asPromissoryNoteId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { GameMode } from "../types/enums";
import { hasPoKContent } from "../rules/gameMode";

/**
 * RR: promissory note setup. Generic notes (Ceasefire, Trade Agreement,
 * Political Secret, Support for the Throne, Alliance) are assigned by
 * PLAYER COLOR, not faction — each player gets all 4 (5 in PoK, with
 * Alliance) matching THEIR OWN color, plus their faction's own note(s)
 * (2 for Empyrean, 1 for everyone else), all starting in hand.
 *
 * This only builds the STARTING assignment (who owns which concrete note,
 * seeded into their hand) — actually TRADING notes (PROPOSE_TRANSACTION)
 * and resolving a note's printed effect (e.g. Ceasefire's move-blocking,
 * Trade Agreement's commodity-stealing) are NOT implemented yet, same
 * deferred-content bucket as action cards and faction abilities. Playing
 * this out requires hooking into many different action handlers (system
 * activation, commodity replenishment, agenda reveal, etc.) — a bigger
 * piece of work than seeding the data correctly, which is what this does.
 */

export interface PromissoryNoteSetupResult {
  /** Every concrete note instance in this game, keyed by its id, with who it belongs to and its display text. Ownership is fixed for the whole game (doesn't change even if the owner later gets eliminated — RR's elimination cleanup for these is a separate, not-yet-built concern). */
  instances: Record<PromissoryNoteId, { ownerId: PlayerId; name: string; timing: string; effect: string; placeInPlayArea: boolean }>;
  /** Each player's starting hand — all of their own notes (generic + faction), before any trading has happened. */
  startingHands: Record<PlayerId, PromissoryNoteId[]>;
}

export function initializePromissoryNotes(
  players: { id: PlayerId; color: string; factionId: FactionId }[],
  rules: RuleData,
  mode: GameMode,
): PromissoryNoteSetupResult {
  const instances: PromissoryNoteSetupResult["instances"] = {};
  const startingHands: PromissoryNoteSetupResult["startingHands"] = {};

  for (const player of players) {
    const hand: PromissoryNoteId[] = [];

    for (const [templateId, template] of Object.entries(rules.genericPromissoryNoteTemplates)) {
      if (template.set === "pok" && !hasPoKContent(mode)) continue; // Alliance is PoK-only
      const instanceId = asPromissoryNoteId(`${templateId}_${player.color}`);
      instances[instanceId] = {
        ownerId: player.id,
        name: template.name,
        timing: template.timing,
        effect: template.effect,
        placeInPlayArea: template.placeInPlayArea,
      };
      hand.push(instanceId);
    }

    for (const factionNote of rules.factionPromissoryNotes[player.factionId] ?? []) {
      const instanceId = asPromissoryNoteId(factionNote.id);
      instances[instanceId] = {
        ownerId: player.id,
        name: factionNote.name,
        timing: factionNote.timing,
        effect: factionNote.effect,
        placeInPlayArea: factionNote.placeInPlayArea,
      };
      hand.push(instanceId);
    }

    startingHands[player.id] = hand;
  }

  return { instances, startingHands };
         }
