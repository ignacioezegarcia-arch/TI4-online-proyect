// Anti-cheat: apply_action/index.ts is documented as "the sole authority
// for game state", but it was passing `action` straight from the HTTP
// request body into GameEngine.applyAction with no server-side dice
// generation at all — every dice-bearing field (combat rolls, gravity
// rift removal, Space Cannon, etc.) was 100% whatever numbers the CLIENT
// happened to send. Nothing re-rolled them, nothing checked they were
// plausible; the engine's own validation only ever checks that the
// COUNT of dice matches what the action requires, never that the VALUES
// are honest. A client could trivially always send maximum (or always-
// hit) values.
//
// Every roll in TI4 is a 10-sided die (combat, bombardment, Space
// Cannon, Anti-Fighter Barrage, gravity rift removal — all of it), which
// is what makes a single GENERIC fix possible here instead of needing
// bespoke server-side dice-count business logic duplicated per action
// type: walk the incoming action, and for every field whose NAME is a
// known "this holds real dice values" field, replace each number with a
// FRESH, server-generated 1-10 value — preserving the exact array length
// the client sent, since the engine's own existing length checks (e.g.
// "need exactly `count` rolls") already correctly reject a wrong COUNT;
// this only makes sure the VALUES within a correctly-shaped request
// aren't attacker-chosen. Called unconditionally on every action before
// it ever reaches GameEngine.applyAction — see apply_action/index.ts.

const DICE_FIELD_NAMES = new Set([
  "diceRolls",
  "dieRolls",
  "newDiceRolls",
  "newRolls",
  "dieRoll",
  "fractureDieRoll",
  "gravityRiftDieRoll",
  "specOpsRespawnDieRolls",
  "rolls", // nested inside gravityRiftDieRolls' own per-rift-instance entries
  "roll", // USE_IXTHIAN_ARTIFACT_DIE_ROLL's own "the speaker's own pre-rolled die"
]);

/** Deno's own Web Crypto API — a real, non-predictable source, not Math.random() (whose internal state, while not client-observable either, is a weaker guarantee to lean on for something explicitly documented as this project's anti-cheat linchpin). */
function rollD10(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 10) + 1;
}

export function regenerateDiceFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => regenerateDiceFields(v));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (DICE_FIELD_NAMES.has(key)) {
        if (typeof val === "number") {
          result[key] = rollD10();
        } else if (Array.isArray(val)) {
          result[key] = val.map((entry) => (typeof entry === "number" ? rollD10() : regenerateDiceFields(entry)));
        } else {
          result[key] = val;
        }
      } else {
        result[key] = regenerateDiceFields(val);
      }
    }
    return result;
  }
  return value;
}
