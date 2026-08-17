/**
 * Player identity.
 *
 * The draft room and your valuation CSV will not agree on how to spell a name.
 * "Marvin Harrison Jr.", "Marvin Harrison Jr", "M. Harrison Jr." and
 * "Harrison Jr., Marvin" all need to collapse to one key, or the analytics
 * silently treat a drafted player as still available -- the single worst
 * failure mode this tool can have.
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Team defenses are named a dozen different ways across platforms. */
const DST_ALIASES = new Map([
  ['dst', 'DST'], ['d/st', 'DST'], ['def', 'DST'], ['defense', 'DST'],
  ['d', 'DST'], ['dt', 'DST'],
]);

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

export function normalizePosition(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/[^a-z/]/g, '');
  if (DST_ALIASES.has(key)) return 'DST';
  const upper = key.toUpperCase();
  return POSITIONS.includes(upper) ? upper : upper || null;
}

/**
 * Collapse a display name to a match key.
 * "Marvin Harrison Jr." -> "marvin harrison"
 */
export function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  // "Harrison Jr., Marvin" -> "Marvin Harrison Jr."
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2);
    if (first && first.trim()) s = `${first.trim()} ${last.trim()}`;
  }

  s = s.toLowerCase()
    .replace(/[.'`’]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = s.split(' ').filter((w) => !SUFFIXES.has(w));
  return parts.join(' ');
}

/** Stable identity for a player across sources. */
export function playerKey(name, position) {
  const pos = normalizePosition(position);
  return `${normalizeName(name)}|${pos ?? '?'}`;
}

/**
 * Resolve an observed (name, position, nflTeam) against a valuation index.
 *
 * Tiers, most to least trustworthy:
 *   1. exact normalized name + position
 *   2. exact normalized name (position disagreement -- platforms differ on
 *      dual-eligible players, so trust the name)
 *   3. last name + position + NFL team (handles "M. Harrison" abbreviations)
 *
 * Returns { player, confidence, tier } or null. Callers should surface
 * anything below 1.0 for operator review rather than acting on it blindly.
 */
export function resolvePlayer(index, { name, position, nflTeam } = {}) {
  const nName = normalizeName(name);
  if (!nName) return null;
  const pos = normalizePosition(position);

  const exact = index.byKey.get(`${nName}|${pos}`);
  if (exact) return { player: exact, confidence: 1, tier: 'name+pos' };

  const byName = index.byName.get(nName);
  if (byName && byName.length === 1) {
    return { player: byName[0], confidence: 0.9, tier: 'name' };
  }
  if (byName && byName.length > 1 && pos) {
    const hit = byName.find((p) => p.position === pos);
    if (hit) return { player: hit, confidence: 0.9, tier: 'name' };
  }

  const last = nName.split(' ').at(-1);
  if (last && pos) {
    const candidates = (index.byLastName.get(last) ?? []).filter(
      (p) => p.position === pos,
    );
    const narrowed = nflTeam
      ? candidates.filter(
          (p) => (p.nflTeam ?? '').toUpperCase() === String(nflTeam).toUpperCase(),
        )
      : candidates;
    const pool = narrowed.length ? narrowed : candidates;
    if (pool.length === 1) {
      return { player: pool[0], confidence: 0.7, tier: 'lastname+pos' };
    }
  }

  return null;
}

/** Build the lookup structure `resolvePlayer` expects from a flat player list. */
export function buildIndex(players) {
  const index = { byKey: new Map(), byName: new Map(), byLastName: new Map(), all: players };
  for (const p of players) {
    const n = normalizeName(p.name);
    index.byKey.set(`${n}|${p.position}`, p);
    if (!index.byName.has(n)) index.byName.set(n, []);
    index.byName.get(n).push(p);
    const last = n.split(' ').at(-1);
    if (last) {
      if (!index.byLastName.has(last)) index.byLastName.set(last, []);
      index.byLastName.get(last).push(p);
    }
  }
  return index;
}
