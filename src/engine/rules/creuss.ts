import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asAbilityId } from "../types/ids";
import { RuleData, getUnitStats } from "../types/RuleData";
import { WormholeType } from "../types/enums";
import { hasAbility } from "./abilities";
import { maybeActivateWormholeNexus } from "./adjacency";
import { hasCodex } from "./gameMode";
import { checkReinforcementsAvailable } from "./reinforcements";

/**
 * Shared "place or move a Creuss wormhole token" logic — used by
 * Wormhole Generator (both versions), Creuss IFF, and Icarus Drive.
 * Confirmed (yjmrobert.com/tirules/factions/f_creuss):
 *  - The target must be a system that contains a planet this player
 *    controls, OR a non-home system that does not contain another
 *    player's ships.
 *  - Cannot place wormhole tokens in the home system of an eliminated
 *    player.
 *  - "The Creuss player may move a wormhole token from the system it
 *    is in INTO THE SAME SYSTEM" — i.e. a no-op relocation is
 *    explicitly legal (not an error), confirmed for both Wormhole
 *    Generator versions.
 *  - Moving a token into the Wormhole Nexus while inactive will flip
 *    it (reuses this project's own existing maybeActivateWormholeNexus).
 *
 * TOKEN IDENTITY: confirmed by the user directly — these are Creuss's
 * own limited PHYSICAL FACTION COMPONENTS (1 alpha token, 1 beta
 * token, 1 gamma token; data/factions/creuss.json's own
 * factionSpecificComponents), not a generic "add this wormhole type to
 * a system" effect. Their own CURRENT location is tracked explicitly
 * via GameState.creussWormholeTokenLocations (keyed by wormhole type),
 * rather than trusting a caller-supplied fromSystemId — this matters
 * because a system's own SystemState.wormholes array doesn't
 * distinguish a PRINTED map wormhole from Creuss's own placed token;
 * blindly stripping "wormholeType" from whatever fromSystemId a caller
 * happened to pass could silently strip a printed one instead of the
 * actual token, or simply be wrong if the caller doesn't actually know
 * where the token currently sits. The token's own previous system (if
 * any) is looked up here directly instead.
 */
export function placeOrMoveCreussWormholeToken(
  state: GameState,
  playerId: PlayerId,
  wormholeType: "alpha" | "beta" | "gamma",
  toSystemId: SystemId,
  rules: RuleData,
): { ok: true; state: GameState } | { ok: false; error: string } {
  const targetSystem = state.systems[toSystemId];
  if (!targetSystem) return { ok: false, error: `No system ${toSystemId}.` };

  const eliminatedHomeSystemIds = Object.values(state.players)
    .filter((p) => p.eliminated)
    .map((p) => rules.homeSystemByFaction[p.factionId]);
  if (eliminatedHomeSystemIds.includes(toSystemId)) {
    return { ok: false, error: "Cannot place a Creuss wormhole token in the home system of an eliminated player." };
  }

  const fromSystemId = state.creussWormholeTokenLocations?.[wormholeType];

  if (fromSystemId !== toSystemId) {
    const targetIsThisPlayersHome = rules.homeSystemByFaction[state.players[playerId]?.factionId] === toSystemId;
    const controlsAPlanetHere = targetSystem.planets.some((p) => p.controllerId === playerId);
    const hasEnemyShips = Object.entries(targetSystem.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== playerId && (stacks ?? []).some((s) => s.count > 0));
    if (!controlsAPlanetHere && (targetIsThisPlayersHome || hasEnemyShips)) {
      return { ok: false, error: "That system must contain a planet this player controls, or be a non-home system without another player's ships." };
    }
    if (targetIsThisPlayersHome && !controlsAPlanetHere) {
      return { ok: false, error: "Cannot place a Creuss wormhole token in this player's own home system unless they control a planet there." };
    }
  }

  let nextState: GameState = state;
  // Only strip the wormhole type from the PREVIOUS system if THIS TOKEN was actually the source of it there — if that system also happens to have a naturally-printed wormhole of the same type (e.g. a base map tile), a second, DIFFERENT source could still legitimately keep it; a per-token "was this the token's own presence" flag isn't tracked at that granularity, so this only removes it when the token was the ONLY reason this project's own state considered that system to have this wormhole type. In practice (per RR/FAQ) Creuss's own token is never placed onto a system that already has a matching printed wormhole, so this distinction is moot for any legal placement — but the check is here for correctness regardless.
  if (fromSystemId && fromSystemId !== toSystemId) {
    const fromSystem = nextState.systems[fromSystemId];
    if (fromSystem) {
      nextState = { ...nextState, systems: { ...nextState.systems, [fromSystemId]: { ...fromSystem, wormholes: fromSystem.wormholes.filter((w) => w !== wormholeType) } } };
    }
  }
  if (!targetSystem.wormholes.includes(wormholeType)) {
    nextState = { ...nextState, systems: { ...nextState.systems, [toSystemId]: { ...nextState.systems[toSystemId], wormholes: [...nextState.systems[toSystemId].wormholes, wormholeType] } } };
  }
  nextState = { ...nextState, creussWormholeTokenLocations: { ...nextState.creussWormholeTokenLocations, [wormholeType]: toSystemId } };
  nextState = maybeActivateWormholeNexus(nextState, rules, toSystemId);

  return { ok: true, state: nextState };
}

/**
 * Ghosts of Creuss "Wormhole Generator" (faction tech, original/base
 * version): "At the start of the status phase, place or move a Creuss
 * wormhole token into either a system that contains a planet you
 * control or a non-home system that does not contain another player's
 * ships." Confirmed (yjmrobert.com/tirules/factions/f_creuss): "this
 * ability is mandatory for the Creuss player in every status phase
 * after it has been researched." Same "no separate id for original vs
 * Ω" data situation as Muaat's own Magmus Reactor — see
 * rules/muaat.ts's own doc comments for the fuller explanation; gated
 * here by game mode instead of a fake separate tech id.
 */
export function useWormholeGenerator(
  state: GameState,
  action: { type: "USE_WORMHOLE_GENERATOR"; playerId: PlayerId; wormholeType: "alpha" | "beta" | "gamma"; toSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("wormhole_generator" as never)) {
    return { ok: false, error: "This player doesn't have Wormhole Generator." };
  }
  const result = placeOrMoveCreussWormholeToken(state, action.playerId, action.wormholeType, action.toSystemId, rules);
  if (!result.ok) return result;
  const remainingPending = (result.state.pendingWormholeGeneratorPlacements ?? []).filter((id) => id !== action.playerId);
  return { ok: true, state: { ...result.state, pendingWormholeGeneratorPlacements: remainingPending.length > 0 ? remainingPending : undefined }, events: [] };
}

/**
 * Ghosts of Creuss "Wormhole Generator Ω" (faction tech, Codex
 * version): "ACTION: Exhaust this card to place or move a Creuss
 * wormhole token into either a system that contains a planet you
 * control or a non-home system that does not contain another player's
 * ships." Same underlying mechanic as the original above, just as a
 * repeatable exhaustable action instead of a mandatory once-per-status-
 * phase trigger — gated by hasCodex(state.mode).
 */
export function useWormholeGeneratorOmega(
  state: GameState,
  action: { type: "USE_WORMHOLE_GENERATOR_OMEGA"; playerId: PlayerId; wormholeType: "alpha" | "beta" | "gamma"; toSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("wormhole_generator" as never) || !hasCodex(state.mode)) {
    return { ok: false, error: "This player doesn't have Wormhole Generator Ω." };
  }
  if (player.exhaustedTechnologies.includes("wormhole_generator" as never)) {
    return { ok: false, error: "Wormhole Generator Ω is already exhausted." };
  }
  const result = placeOrMoveCreussWormholeToken(state, action.playerId, action.wormholeType, action.toSystemId, rules);
  if (!result.ok) return result;
  const updatedPlayer: Player = { ...result.state.players[action.playerId], exhaustedTechnologies: [...result.state.players[action.playerId].exhaustedTechnologies, "wormhole_generator" as never] };
  return { ok: true, state: { ...result.state, players: { ...result.state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

function findCreussPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("creuss" as never))?.id;
}

/**
 * Ghosts of Creuss "Creuss Iff" (promissory note): "ACTION: Place or
 * move a Creuss wormhole token into either a system that contains a
 * planet you control or a non-home system that does not contain
 * another player's ships. Then, return this card to the Creuss
 * player." Confirmed (yjmrobert.com/tirules/factions/f_creuss):
 *  - May be played even if the Creuss player has not researched
 *    Wormhole Generator.
 *  - Any deal about WHERE the tokens go, made before the exchange, is
 *    non-binding.
 *  - Cannot place in an eliminated player's home system (already
 *    covered by placeOrMoveCreussWormholeToken's own shared check).
 *  - A player may receive Creuss Iff in a transaction during their own
 *    turn, and may even play it immediately if received at the START
 *    of that turn — no special handling needed here since this is
 *    already just a normal promissory note in hand once received.
 */
export function useCreussIff(
  state: GameState,
  action: { type: "USE_CREUSS_IFF"; playerId: PlayerId; wormholeType: "alpha" | "beta" | "gamma"; toSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("creuss_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Creuss Iff in hand." };
  }
  const creussPlayerId = findCreussPlayerId(state);
  if (!creussPlayerId) return { ok: false, error: "No Ghosts of Creuss player in this game." };

  const result = placeOrMoveCreussWormholeToken(state, action.playerId, action.wormholeType, action.toSystemId, rules);
  if (!result.ok) return result;

  const creussPlayer = result.state.players[creussPlayerId];
  const updatedPlayer: Player = { ...result.state.players[action.playerId], promissoryNotesInHand: result.state.players[action.playerId].promissoryNotesInHand.filter((id) => id !== ("creuss_promissory" as never)) };
  const updatedCreussPlayer: Player = { ...creussPlayer, promissoryNotesInHand: [...creussPlayer.promissoryNotesInHand, "creuss_promissory" as never] };

  return {
    ok: true,
    state: { ...result.state, players: { ...result.state.players, [action.playerId]: updatedPlayer, [creussPlayerId]: updatedCreussPlayer } },
    events: [],
  };
}

/**
 * Ghosts of Creuss "Icarus Drive" (mech): "After any player activates a
 * system, you may remove this unit from the game board to place or
 * move a Creuss wormhole token into this system." Confirmed
 * (yjmrobert.com/tirules/factions/f_creuss): "'this system' refers to
 * the system that contains the mech, NOT the system that was
 * activated" — "the Icarus Drive does not have to be in the activated
 * system" — the wormhole is placed in the MECH's OWN system, matching
 * the raw data's own note. Removing the unit means it goes to
 * reinforcements (a normal "unit destroyed/removed" outcome, not
 * purged from the game — matching the standard RR meaning of "remove
 * from the game board").
 */
export function useIcarusDrive(
  state: GameState,
  action: { type: "USE_ICARUS_DRIVE"; playerId: PlayerId; icarusDriveSystemId: SystemId; wormholeType: "alpha" | "beta" | "gamma" },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const system = state.systems[action.icarusDriveSystemId];
  if (!system) return { ok: false, error: `No system ${action.icarusDriveSystemId}.` };

  const mechPlanet = system.planets.find((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0));
  const mechInSpace = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0);
  if (!mechPlanet && !mechInSpace) return { ok: false, error: "This player has no Icarus Drive in that system." };

  const result = placeOrMoveCreussWormholeToken(state, action.playerId, action.wormholeType, action.icarusDriveSystemId, rules);
  if (!result.ok) return result;

  let nextState = result.state;
  if (mechPlanet) {
    const stacks = mechPlanet.unitsByPlayer[action.playerId] ?? [];
    const mechStack = stacks.find((s) => s.unitType === "mech" && s.count > 0)!;
    const updatedStacks = stacks.map((s) => (s === mechStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    const updatedPlanet: PlanetState = { ...mechPlanet, unitsByPlayer: { ...mechPlanet.unitsByPlayer, [action.playerId]: updatedStacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [action.icarusDriveSystemId]: { ...nextState.systems[action.icarusDriveSystemId], planets: nextState.systems[action.icarusDriveSystemId].planets.map((p) => (p.planetId === mechPlanet.planetId ? updatedPlanet : p)) } } };
  } else {
    const spaceStacks = nextState.systems[action.icarusDriveSystemId].spaceUnitsByPlayer[action.playerId] ?? [];
    const mechStack = spaceStacks.find((s) => s.unitType === "mech" && s.count > 0)!;
    const updatedSpaceStacks = spaceStacks.map((s) => (s === mechStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    nextState = { ...nextState, systems: { ...nextState.systems, [action.icarusDriveSystemId]: { ...nextState.systems[action.icarusDriveSystemId], spaceUnitsByPlayer: { ...nextState.systems[action.icarusDriveSystemId].spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks } } } };
  }

  return { ok: true, state: nextState, events: [] };
}

/**
 * Ghosts of Creuss "Dimensional Splicer" (faction tech): "At the start
 * of space combat in a system that contains a wormhole and 1 or more
 * of your ships, you may produce 1 hit and assign it to 1 of your
 * opponent's ships." Confirmed (yjmrobert.com/tirules/factions/f_creuss):
 *  - ANY wormhole may trigger this, including the delta wormhole
 *    produced by the Hil Colish's own ability.
 *  - Only 1 hit is produced, even if the system contains multiple
 *    wormholes.
 *  - The Creuss player chooses which ship the hit is assigned to.
 *  - Shields Holding/Sustain Damage/Direct Hit/Reflective Shielding
 *    may all interact with this hit normally — achieved for free by
 *    queueing it into the SAME pendingHits mechanism every other
 *    hit-producing ability uses, so the normal ASSIGN_HITS flow
 *    (including all 4 of those cards/abilities) already applies to it
 *    without anything extra.
 */
export function useDimensionalSplicer(state: GameState, action: { type: "USE_DIMENSIONAL_SPLICER"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("dimensional_splicer" as never)) {
    return { ok: false, error: "This player doesn't have Dimensional Splicer." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat" || pending.combatRound !== 1) {
    return { ok: false, error: "Dimensional Splicer is only usable at the start of space combat." };
  }
  const system = state.systems[pending.systemId];
  if (!system.wormholes || system.wormholes.length === 0) {
    return { ok: false, error: "Dimensional Splicer: that system must contain a wormhole." };
  }
  if (!(system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0)) {
    return { ok: false, error: "This player has no ships of their own in that system." };
  }
  const opponentId = Object.keys(system.spaceUnitsByPlayer).find((id) => id !== action.playerId && (system.spaceUnitsByPlayer[id as PlayerId] ?? []).some((s) => s.count > 0)) as PlayerId | undefined;
  if (!opponentId) return { ok: false, error: "No opponent in this system." };

  const nextState: GameState = { ...state, pendingTacticalAction: { ...pending, pendingHits: { ...pending.pendingHits, [opponentId]: (pending.pendingHits?.[opponentId] ?? 0) + 1 } } };
  return { ok: true, state: nextState, events: [{ type: "HARROW_HITS_SCORED", playerId: action.playerId, targetPlayerId: opponentId, hits: 1 }] };
}

/**
 * Ghosts of Creuss "Emissary Taivra" (agent): "After a player activates
 * a system that contains a non-delta wormhole: You may exhaust this
 * card; if you do, that system is adjacent to all other systems that
 * contain a wormhole during this tactical action." Confirmed
 * (yjmrobert.com/tirules/factions/f_creuss):
 *  - Can be used to access an inactive Wormhole Nexus without a gamma
 *    wormhole of its own — moving ships there this way flips it
 *    (already handled generically, since placeOrMoveCreussWormholeToken/
 *    normal movement both already call maybeActivateWormholeNexus on
 *    arrival).
 *  - A delta wormhole in the system (e.g. from the Hil Colish) does
 *    NOT prevent this ability from being usable — only relevant to
 *    OTHER wormholes possibly ALSO being in that system; the TRIGGER
 *    condition itself requires a NON-delta wormhole specifically.
 *  - The system must have a non-delta wormhole in it at the moment of
 *    activation — if a wormhole was placed via Icarus Drive in a
 *    system with no other wormholes, Emissary Taivra cannot be used
 *    for THAT SAME activation (but CAN be used for the very next one).
 *    KNOWN SCOPE LIMIT: this precise "at the moment of activation, not
 *    after a same-activation Icarus Drive placement" ordering nuance
 *    isn't separately enforced here — the caller is trusted to check
 *    this against the system's OWN wormholes as they stood right when
 *    activation happened, same "trusted timing" convention as
 *    elsewhere.
 */
export function useEmissaryTaivra(state: GameState, action: { type: "USE_EMISSARY_TAIVRA"; playerId: PlayerId; targetSystemId: SystemId } ): ActionResult {
  const player = state.players[action.playerId];
  const agentEntry = player.leaders.find((l) => l.leaderId === ("creuss_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have Emissary Taivra." };
  if (agentEntry.exhausted) return { ok: false, error: "Emissary Taivra is already exhausted." };

  const system = state.systems[action.targetSystemId];
  if (!system?.wormholes.some((w) => w !== "delta")) {
    return { ok: false, error: "Emissary Taivra: that system must contain a non-delta wormhole." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.systemId !== action.targetSystemId) {
    return { ok: false, error: "Emissary Taivra: that system isn't the currently active one." };
  }

  const updatedPlayer: Player = { ...player, leaders: player.leaders.map((l) => (l.leaderId === ("creuss_agent" as never) ? { ...l, exhausted: true } : l)) };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, pendingTacticalAction: { ...pending, emissaryTaivraActiveSystemId: action.targetSystemId } },
    events: [],
  };
}

/**
 * Ghosts of Creuss "Sai Seravus" (commander): "After your ships move:
 * For each of your ships with capacity that moved through 1 or more
 * wormholes during this movement, you may place 1 fighter with it from
 * your reinforcements if it has unused capacity." No additional
 * confirmed rulings beyond the printed text — works for ANY movement
 * (not just a tactical action's own primary move step; e.g. a
 * transport, a retreat, or an ability-driven move like Foresight/
 * Icarus Drive's own relocations). Modeled as a reactive follow-up
 * action; the caller identifies which of this player's own ships (by
 * unit type + count, all now sitting together in the SAME destination
 * system) actually moved through 1+ wormholes this movement — same
 * "trusted timing" convention as elsewhere, since this project's own
 * movement validation doesn't expose the exact path taken back to the
 * caller as a distinct, reusable object.
 */
export function useSaiSeravus(
  state: GameState,
  action: { type: "USE_SAI_SERAVUS"; playerId: PlayerId; destinationSystemId: SystemId; shipsMovedThroughWormholes: { unitType: import("../types/enums").UnitType; count: number }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("creuss_commander" as never));
  if (!commanderEntry || commanderEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Sai Seravus." };

  const system = state.systems[action.destinationSystemId];
  if (!system) return { ok: false, error: `No system ${action.destinationSystemId}.` };

  let totalFightersToPlace = 0;
  for (const { unitType, count } of action.shipsMovedThroughWormholes) {
    const stack = (system.spaceUnitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === unitType);
    if (!stack || stack.count < count) return { ok: false, error: `Not enough ${unitType} of this player's own in ${action.destinationSystemId}.` };
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats?.capacity) return { ok: false, error: `${unitType} has no capacity.` };
    totalFightersToPlace += count;
  }
  if (totalFightersToPlace <= 0) return { ok: false, error: "No qualifying ships specified." };

  const currentCargo = (system.spaceUnitsByPlayer[action.playerId] ?? []).reduce((sum, s) => (s.unitType === "fighter" || (["infantry", "mech"] as const).includes(s.unitType as never) ? sum + s.count : sum), 0);
  const totalCapacity = (system.spaceUnitsByPlayer[action.playerId] ?? []).reduce((sum, s) => {
    const stats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return sum + (stats?.capacity ?? 0) * s.count;
  }, 0);
  const unusedCapacity = totalCapacity - currentCargo;
  const toPlace = Math.min(totalFightersToPlace, Math.max(0, unusedCapacity));
  if (toPlace <= 0) return { ok: true, state, events: [] };

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "fighter" as const, count: toPlace }]);
  const actuallyPlaced = reinforcementsCheck.ok ? toPlace : 0;
  if (actuallyPlaced <= 0) return { ok: true, state, events: [] };

  const stacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "fighter");
  const updatedStacks = existing ? stacks.map((s) => (s.unitType === "fighter" ? { ...s, count: s.count + actuallyPlaced } : s)) : [...stacks, { unitType: "fighter" as const, count: actuallyPlaced, damagedCount: 0 }];
  const nextState: GameState = { ...state, systems: { ...state.systems, [action.destinationSystemId]: { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } } } };

  return { ok: true, state: nextState, events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.destinationSystemId, unitType: "fighter", count: actuallyPlaced, totalCost: 0 }] };
}

/**
 * Ghosts of Creuss "Riftwalker Meian — SINGULARITY REACTOR" (hero,
 * single-use): "ACTION: Swap the positions of any 2 systems that
 * contain wormholes or your units, other than the Creuss system and
 * the Wormhole Nexus. Then, purge this card." No additional confirmed
 * rulings beyond the printed text. Modeled as swapping the entire
 * SystemState CONTENTS between the 2 SystemId keys (planets, units,
 * wormholes, anomalies — everything a physical tile carries), which
 * correctly moves any Creuss wormhole token along with its own tile —
 * creussWormholeTokenLocations is re-derived from the post-swap
 * systems afterward so its own tracked locations stay consistent
 * rather than pointing at stale positions.
 */
export function useRiftwalkerMeian(state: GameState, action: { type: "USE_RIFTWALKER_MEIAN"; playerId: PlayerId; systemIdA: SystemId; systemIdB: SystemId }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("creuss_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Riftwalker Meian." };

  if (action.systemIdA === action.systemIdB) return { ok: false, error: "Cannot swap a system with itself." };
  const systemA = state.systems[action.systemIdA];
  const systemB = state.systems[action.systemIdB];
  if (!systemA || !systemB) return { ok: false, error: "One or both systems don't exist." };

  const creussHomeSystemId = rules.homeSystemByFaction["creuss"];
  if (action.systemIdA === creussHomeSystemId || action.systemIdB === creussHomeSystemId) {
    return { ok: false, error: "Cannot swap the Creuss home system." };
  }
  if (action.systemIdA === rules.wormholeNexusSystemId || action.systemIdB === rules.wormholeNexusSystemId) {
    return { ok: false, error: "Cannot swap the Wormhole Nexus system." };
  }

  const qualifies = (system: SystemState) =>
    system.wormholes.length > 0 ||
    (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0) ||
    system.planets.some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0));
  if (!qualifies(systemA) || !qualifies(systemB)) {
    return { ok: false, error: "Both systems must contain a wormhole or this player's own units." };
  }

  let nextState: GameState = { ...state, systems: { ...state.systems, [action.systemIdA]: systemB, [action.systemIdB]: systemA } };

  // Re-derive creussWormholeTokenLocations from the post-swap board, so tracked locations reflect wherever each token's own wormhole type actually ended up.
  const updatedLocations: Partial<Record<"alpha" | "beta" | "gamma", SystemId>> = { ...nextState.creussWormholeTokenLocations };
  for (const wormholeType of ["alpha", "beta", "gamma"] as const) {
    if (updatedLocations[wormholeType] === action.systemIdA) updatedLocations[wormholeType] = action.systemIdB;
    else if (updatedLocations[wormholeType] === action.systemIdB) updatedLocations[wormholeType] = action.systemIdA;
  }
  nextState = { ...nextState, creussWormholeTokenLocations: updatedLocations };

  // Same re-derivation for the 3 GENERIC gamma wormhole tokens (Cultural/Frontier/Nexus Sovereignty) — see rules/wormholeTokens.ts.
  nextState = {
    ...nextState,
    genericGammaWormholeTokens: nextState.genericGammaWormholeTokens.map((t) => {
      if (t.systemId === action.systemIdA) return { ...t, systemId: action.systemIdB };
      if (t.systemId === action.systemIdB) return { ...t, systemId: action.systemIdA };
      return t;
    }),
  };

  const updatedPlayer: Player = { ...player, leaders: player.leaders.filter((l) => l.leaderId !== ("creuss_hero" as never)) };
  return { ok: true, state: { ...nextState, players: { ...nextState.players, [action.playerId]: updatedPlayer } }, events: [] };
}
