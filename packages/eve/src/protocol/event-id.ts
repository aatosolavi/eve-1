/** Prefix stamped on every eve session stream event id. */
export const EVENT_ID_PREFIX = "evt_";

/** Character count of the ULID body that follows {@link EVENT_ID_PREFIX}. */
export const EVENT_ID_BODY_LENGTH = 26;

// Crockford base32: no I, L, O, or U, so a transcribed id cannot be confused
// with 1/0 and the alphabet stays sort-order-compatible with the raw bits.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;

let lastTimeMs = -1;
const lastRandom = new Uint8Array(RANDOM_BYTES);

/**
 * Mints a unique, lexicographically sortable event id.
 *
 * The value is `evt_` followed by a 26-character ULID: a 48-bit millisecond
 * timestamp then 80 bits of randomness, both in Crockford base32. Sorting ids
 * as strings therefore reproduces emission order, which keeps a primary key
 * built on this id chronologically clustered in a database.
 *
 * Ids minted within the same millisecond increment the random component rather
 * than re-randomizing it, so they still sort in emission order. A clock that
 * moves backwards is pinned to the last observed millisecond for the same
 * reason: monotonicity outranks timestamp precision, because consumers order by
 * the id and read the exact emission time from `meta.at`.
 */
export function createEventId(): string {
  const now = Date.now();

  if (now > lastTimeMs) {
    lastTimeMs = now;
    randomFill(lastRandom);
  } else if (!incrementRandom(lastRandom)) {
    // 2^80 ids inside one millisecond. Unreachable in practice; advancing the
    // logical clock keeps the generator monotonic instead of blocking on it.
    lastTimeMs += 1;
    randomFill(lastRandom);
  }

  return `${EVENT_ID_PREFIX}${encodeTime(lastTimeMs)}${encodeRandom(lastRandom)}`;
}

/**
 * Returns true when `value` has the shape {@link createEventId} produces.
 *
 * Shape-only: this does not prove eve minted the id.
 */
export function isEventId(value: string): boolean {
  if (!value.startsWith(EVENT_ID_PREFIX)) return false;
  const body = value.slice(EVENT_ID_PREFIX.length);
  if (body.length !== EVENT_ID_BODY_LENGTH) return false;
  for (const character of body) {
    if (!ENCODING.includes(character)) return false;
  }
  return true;
}

function randomFill(target: Uint8Array<ArrayBuffer>): void {
  // Web Crypto rather than `node:crypto`, because this module is bundled into
  // browser clients and into the workflow step sandbox. `getRandomValues` is
  // also available in insecure browser contexts, unlike `randomUUID`.
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("Cannot mint an event id: globalThis.crypto.getRandomValues is unavailable.");
  }
  webCrypto.getRandomValues(target);
}

function encodeTime(timeMs: number): string {
  let remaining = timeMs;
  let encoded = "";
  for (let index = 0; index < TIME_CHARS; index += 1) {
    encoded = ENCODING[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits divide evenly into 16 five-bit groups, so no padding is needed.
  let buffer = 0;
  let bufferedBits = 0;
  let encoded = "";

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;
    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      encoded += ENCODING[(buffer >>> bufferedBits) & 31];
    }
    buffer &= (1 << bufferedBits) - 1;
  }

  return encoded.padStart(RANDOM_CHARS, ENCODING[0]);
}

/** Adds one to a big-endian counter in place. Returns false on overflow. */
function incrementRandom(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 0xff) {
      bytes[index] = byte + 1;
      return true;
    }
    bytes[index] = 0;
  }
  return false;
}
