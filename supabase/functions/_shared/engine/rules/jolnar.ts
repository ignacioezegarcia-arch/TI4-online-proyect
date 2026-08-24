import { GameState, Player } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, TechId } from "../types/ids";
import { RuleData } from "../types/RuleData";

function findJolNarPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("jolnar" as never))?.id;
}

/**
 * Jol-Nar "Research Agreement" (promissory note): "After the Jol-Nar
 * player researches a technology that is not a faction technology: Gain
 * that technology. Then, return this card to the Jol-Nar player."
 * Confirmed rulings (tirules2.com/F_jol_nar):
 *  - If Jol-Nar researches several technologies in a row, the holder
 *    gets offered this AFTER EACH ONE, and Jol-Nar can't commit to their
 *    NEXT research until the holder has played or declined for the
 *    PREVIOUS one — this project's own simplification: the caller
 *    (Jol-Nar's own player, or whoever is orchestrating turn order) is
 *    trusted to actually offer this in sequence rather than the engine
 *    enforcing a hard block between researches.
 *  - Faction-specific unit upgrades can never be gained this way even if
 *    Jol-Nar researched the GENERIC version of that same unit upgrade —
 *    not applicable to this function at all, since it only ever
 *    operates on TechId (normal technologies), never UnitUpgradeId.
 *  - Can be triggered by many "research" sources beyond the Technology
 *    strategy card (Divert Funding, Focused Research, Reveal Prototype,
 *    Technology Rider, Ixthian Artifact, Wormhole Research, Enigmatic
 *    Device) but NOT by pure "gain" effects that skip research entirely
 *    (Fire of the Gashlai, Plagiarize, Research Grant Reallocation, Maw
 *    of Worlds) or by Genetic Memory — this project has no single choke
 *    point distinguishing "gain" from "research" universally across
 *    every one of those sources, so the caller is trusted to only
 *    invoke this after an actual RESEARCH_TECHNOLOGY action, matching
 *    the same "immediately after X" simplification category as several
 *    other reactive abilities elsewhere in this project.
 *  - Faction technologies (Jol-Nar's own, or ANY faction's) can never be
 *    gained this way — checked directly below.
 */
export function useResearchAgreement(
  state: GameState,
  action: { type: "USE_RESEARCH_AGREEMENT"; playerId: PlayerId; techId: TechId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("jolnar_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Research Agreement in hand." };
  }
  const jolNarPlayerId = findJolNarPlayerId(state);
  if (!jolNarPlayerId) return { ok: false, error: "No Jol-Nar player in this game." };
  const jolNarPlayer = state.players[jolNarPlayerId];
  if (!jolNarPlayer.technologies.includes(action.techId)) {
    return { ok: false, error: "The Jol-Nar player doesn't own that technology." };
  }
  const isFactionTech = rules.factionTechIds.has(action.techId);
  if (isFactionTech) return { ok: false, error: "Research Agreement cannot gain a faction technology." };
  if (player.technologies.includes(action.techId)) {
    return { ok: false, error: "This player already owns that technology." };
  }

  const updatedPlayer: Player = {
    ...player,
    technologies: [...player.technologies, action.techId],
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("jolnar_promissory" as never)),
  };
  const updatedJolNarPlayer: Player = { ...jolNarPlayer, promissoryNotesInHand: [...jolNarPlayer.promissoryNotesInHand, "jolnar_promissory" as never] };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [jolNarPlayerId]: updatedJolNarPlayer } },
    events: [],
  };
}

/**
 * Jol-Nar "Spatial Conduit Cylinder" (faction tech, exhaustable):
 * "Exhaust after you activate a system that contains 1 or more of your
 * units; that system is treated as adjacent to all other systems that
 * contain 1 or more of your units during this system activation."
 * Confirmed (tirules2.com/F_jol_nar): a specific enemy's Deep Space
 * Cannon still applies normally (not built here, not applicable without
 * that faction); gravity-rift removal rolls still apply to ships that
 * actually move; ships can still pass THROUGH intermediate systems en
 * route with capacity/transport — this is an adjacency override for
 * things that check adjacency directly (movement legality, combat-
 * adjacent checks), not a full teleport that erases movement mechanics.
 */
export function useSpatialConduitCylinder(state: GameState, action: { type: "USE_SPATIAL_CONDUIT_CYLINDER"; playerId: PlayerId }): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("spatial_conduit_cylinder" as never)) {
    return { ok: false, error: "This player doesn't have Spatial Conduit Cylinder." };
  }
  if (player.exhaustedTechnologies.includes("spatial_conduit_cylinder" as never)) {
    return { ok: false, error: "Spatial Conduit Cylinder is already exhausted." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) return { ok: false, error: "No tactical action in progress for this player." };
  const hasOwnUnitsHere = (state.systems[pending.systemId]?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  if (!hasOwnUnitsHere) return { ok: false, error: "This player has no units in the activated system." };

  const updatedPlayer: Player = { ...player, exhaustedTechnologies: [...player.exhaustedTechnologies, "spatial_conduit_cylinder" as never] };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, pendingTacticalAction: { ...pending, spatialConduitCylinderActive: { playerId: action.playerId, systemId: pending.systemId } } },
    events: [],
  };
}

/**
 * Jol-Nar "Rin, The Master's Legacy — GENETIC MEMORY" (hero, single-use):
 * "For each non-unit-upgrade technology you own, you may replace it with
 * any other non-unit-upgrade technology of the same color from the
 * general supply. Then, purge this card." Confirmed
 * (tirules2.com/F_jol_nar):
 *  - Bypasses prerequisites entirely (a "gain", not a "research") — no
 *    prerequisite check performed here at all.
 *  - All replacements happen SIMULTANEOUSLY — the caller can't gain back
 *    a tech they're returning as part of this SAME resolution, checked
 *    by validating the full NEW set doesn't reintroduce any OLD id.
 *  - If this player LATER gains one of the technologies they returned
 *    here (through some other, later effect), it comes back readied —
 *    not applicable to this function itself (nothing here exhausts
 *    anything), just noted for whoever implements that later gain.
 */
export function useRinGeneticMemory(
  state: GameState,
  action: { type: "USE_RIN_GENETIC_MEMORY"; playerId: PlayerId; replacements: { oldTechId: TechId; newTechId: TechId }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("jolnar_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Rin, The Master's Legacy." };

  const oldIds = action.replacements.map((r) => r.oldTechId);
  const newIds = action.replacements.map((r) => r.newTechId);
  for (const oldId of oldIds) {
    // player.technologies (TechId[]) never contains unit upgrades in the first place (those live separately in player.unitUpgrades: UnitUpgradeId[]) — "not a unit upgrade" is already guaranteed just by this check existing.
    if (!player.technologies.includes(oldId)) return { ok: false, error: `This player doesn't own ${oldId}.` };
  }
  for (const newId of newIds) {
    if (player.technologies.includes(newId) && !oldIds.includes(newId)) return { ok: false, error: `This player already owns ${newId}.` };
    if (oldIds.includes(newId)) return { ok: false, error: "Cannot immediately regain a technology being returned in this same resolution." };
  }
  for (const { oldTechId, newTechId } of action.replacements) {
    const oldColor = rules.technologies[oldTechId]?.color;
    const newColor = rules.technologies[newTechId]?.color;
    if (!oldColor || oldColor !== newColor) {
      return { ok: false, error: `${newTechId} must be the same color as ${oldTechId} (${oldColor ?? "none"}).` };
    }
  }

  const keptTechs = player.technologies.filter((t) => !oldIds.includes(t));
  const updatedPlayer: Player = {
    ...player,
    technologies: [...keptTechs, ...newIds],
    leaders: player.leaders.filter((l) => l.leaderId !== ("jolnar_hero" as never)),
  };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

