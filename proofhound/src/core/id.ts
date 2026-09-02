/**
 * Id helpers.
 *
 * Investigation ids are random; every id derived from one is deterministic, so
 * re-running the pipeline over the same input produces stable ids. That keeps
 * snapshots, tests and React keys stable.
 */

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function newInvestigationId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Stable, readable id built from a prefix and its parts. */
export function deterministicId(prefix: string, ...parts: string[]): string {
  const slug = parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug ? `${prefix}_${slug}` : prefix;
}

/** Short stable hash, used when a slug would collide or be unreadable. */
export function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(36).padStart(7, '0').slice(0, 7);
}
