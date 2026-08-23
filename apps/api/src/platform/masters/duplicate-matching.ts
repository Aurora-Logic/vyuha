import type { DuplicateEntityType, DuplicateMatchField } from '@vyuha/shared';

/**
 * Area AO's matching, pure and tested: how two pulled records are read as
 * the same thing. One detector, an entity-type config (REQ-AO-01): a
 * party matches on GSTIN, PAN, normalised name, phone, email and address
 * (pincode plus first line); an item on normalised name, alias or part
 * number, unit and group. HSN is not held by the projection, so it is
 * not compared (docs/15 REQ-AO-03 names it; the column does not exist).
 *
 * A GSTIN or PAN match is certainty regardless of the name (D-56). Names
 * match when they collapse to the same key -- case, punctuation, spacing
 * and the usual company suffixes folded -- or when their trigrams overlap
 * enough to be the same name mistyped.
 */

export interface PartyRecord {
  readonly id: string;
  readonly name: string;
  readonly alias: string | null;
  readonly gstin: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
}

export interface ItemRecord {
  readonly id: string;
  readonly name: string;
  readonly alias: string | null;
  readonly unit: string;
  readonly parentGroup: string;
}

export interface PairMatch {
  readonly a: string;
  readonly b: string;
  readonly confidence: number;
  readonly fields: readonly DuplicateMatchField[];
}

export interface Cluster {
  readonly members: readonly string[];
  readonly confidence: number;
  readonly fields: readonly DuplicateMatchField[];
}

/**
 * Legal forms only -- the ways one firm's registration is typed, not what it
 * trades in. "Traders", "Industries" and "Enterprises" were here and had to
 * come out: they made Asha Traders and Asha Industries the same firm, and
 * because a cluster is transitive, one shared first word could chain a dozen
 * unrelated companies into one.
 */
const SUFFIXES = [
  'private limited',
  'pvt ltd',
  'pvt limited',
  'private ltd',
  'p ltd',
  'pvtltd',
  'limited',
  'ltd',
  'llp',
  'opc',
  'inc',
  'corp',
  'corporation',
];

/** Case, punctuation, spacing, "&" for "and", and the suffixes gone; what is left is the name. */
export function normaliseName(raw: string): string {
  let s = raw.toLowerCase().replace(/&/gu, ' and ').replace(/[^a-z0-9]+/gu, ' ').trim().replace(/\s+/gu, ' ');
  // Longest suffix first, and only at the end, repeated so "traders pvt ltd" folds fully.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of [...SUFFIXES].sort((x, y) => y.length - x.length)) {
      if (s === suffix) continue;
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -suffix.length - 1).trim();
        changed = true;
      }
    }
  }
  return s.replace(/\s+/gu, '');
}

/** The digits alone; an Indian mobile with a country code collapses to its last ten. */
export function normalisePhone(raw: string | null): string | null {
  if (raw === null) return null;
  const digits = raw.replace(/\D/gu, '');
  if (digits.length < 6) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normaliseEmail(raw: string | null): string | null {
  if (raw === null) return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(e) ? e : null;
}

export function normaliseGstin(raw: string | null): string | null {
  if (raw === null) return null;
  const g = raw.replace(/\s+/gu, '').toUpperCase();
  return g.length === 15 ? g : null;
}

/** PAN is characters 3 to 12 of a GSTIN; there is no PAN column. */
export function panOf(gstin: string | null): string | null {
  const g = normaliseGstin(gstin);
  return g === null ? null : g.slice(2, 12);
}

/** The address as a key: its pincode and the first line, each normalised; null without a pincode. */
export function normaliseAddress(raw: string | null): string | null {
  if (raw === null) return null;
  const pincode = /\b(\d{6})\b/u.exec(raw)?.[1];
  if (pincode === undefined) return null;
  const firstLine = (raw.split(/[\n,]/u)[0] ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return firstLine === '' ? null : `${pincode}:${firstLine}`;
}

export function normaliseAlias(raw: string | null): string | null {
  if (raw === null) return null;
  const a = raw.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return a.length < 3 ? null : a;
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard overlap of trigrams, 0 to 1: the same name mistyped scores high, different names low. */
export function nameSimilarity(a: string, b: string): number {
  // Two names that normalise to nothing -- a pair written in a script this
  // strips entirely -- are not the same name; they are two unknowns.
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** A mistyped name: close enough to be the same, far enough that "Asha" and "Usha" are not. */
export const NAME_SIMILARITY_MIN = 0.8;

/** The fields that are certainty on their own (D-56). */
const CERTAIN: readonly DuplicateMatchField[] = ['gstin', 'pan'];

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function scoreParties(a: PartyRecord, b: PartyRecord): PairMatch | null {
  const fields: DuplicateMatchField[] = [];
  let score = 0;
  const ga = normaliseGstin(a.gstin);
  const gb = normaliseGstin(b.gstin);
  if (ga !== null && gb !== null && ga === gb) fields.push('gstin');
  const pa = panOf(a.gstin);
  const pb = panOf(b.gstin);
  if (pa !== null && pb !== null && pa === pb && !fields.includes('gstin')) fields.push('pan');
  const na = normaliseName(a.name);
  const nb = normaliseName(b.name);
  if (na !== '' && na === nb) {
    fields.push('name');
    score += 0.85;
  } else if (nameSimilarity(na, nb) >= NAME_SIMILARITY_MIN) {
    fields.push('name');
    score += 0.7;
  }
  const aa = normaliseAlias(a.alias);
  const ab = normaliseAlias(b.alias);
  if (aa !== null && ab !== null && aa === ab) {
    fields.push('alias');
    score += 0.2;
  }
  const pha = normalisePhone(a.phone);
  const phb = normalisePhone(b.phone);
  if (pha !== null && phb !== null && pha === phb) {
    fields.push('phone');
    score += 0.2;
  }
  const ea = normaliseEmail(a.email);
  const eb = normaliseEmail(b.email);
  if (ea !== null && eb !== null && ea === eb) {
    fields.push('email');
    score += 0.2;
  }
  const ada = normaliseAddress(a.address);
  const adb = normaliseAddress(b.address);
  if (ada !== null && adb !== null && ada === adb) {
    fields.push('address');
    score += 0.15;
  }
  if (fields.some((f) => CERTAIN.includes(f))) score = 1;
  if (fields.length === 0) return null;
  // Two contact fields without the name are a strong hint, not certainty.
  return { a: a.id, b: b.id, confidence: round3(Math.min(1, score)), fields: orderFields(fields) };
}

export function scoreItems(a: ItemRecord, b: ItemRecord): PairMatch | null {
  const fields: DuplicateMatchField[] = [];
  let score = 0;
  const aa = normaliseAlias(a.alias);
  const ab = normaliseAlias(b.alias);
  // REQ-AO-03: the same part number under two names is the strongest signal here.
  if (aa !== null && ab !== null && aa === ab) {
    fields.push('alias');
    score += 0.8;
  }
  const na = normaliseName(a.name);
  const nb = normaliseName(b.name);
  if (na !== '' && na === nb) {
    fields.push('name');
    score += 0.8;
  } else if (nameSimilarity(na, nb) >= NAME_SIMILARITY_MIN) {
    fields.push('name');
    score += 0.65;
  }
  if (fields.length === 0) return null;
  if (a.unit.trim().toLowerCase() === b.unit.trim().toLowerCase()) {
    fields.push('unit');
    score += 0.1;
  }
  if (a.parentGroup.trim().toLowerCase() === b.parentGroup.trim().toLowerCase()) {
    fields.push('group');
    score += 0.1;
  }
  return { a: a.id, b: b.id, confidence: round3(Math.min(1, score)), fields: orderFields(fields) };
}

const FIELD_ORDER: readonly DuplicateMatchField[] = ['gstin', 'pan', 'name', 'alias', 'phone', 'email', 'address', 'unit', 'group'];

function orderFields(fields: readonly DuplicateMatchField[]): DuplicateMatchField[] {
  return FIELD_ORDER.filter((f) => fields.includes(f));
}

/**
 * Candidate pairs without comparing everything to everything: records
 * share a block when any key agrees -- normalised name, its first four
 * characters (for the mistyped), GSTIN, PAN, phone, email, address, alias.
 */
export function blockKeys(entityType: DuplicateEntityType, record: PartyRecord | ItemRecord): string[] {
  const keys: string[] = [];
  const name = normaliseName(record.name);
  if (name !== '') {
    keys.push(`n:${name}`);
    if (name.length >= 4) keys.push(`p:${name.slice(0, 4)}`);
  }
  const alias = normaliseAlias(record.alias);
  if (alias !== null) keys.push(`a:${alias}`);
  if (entityType === 'party') {
    const p = record as PartyRecord;
    const g = normaliseGstin(p.gstin);
    if (g !== null) keys.push(`g:${g}`);
    const pan = panOf(p.gstin);
    if (pan !== null) keys.push(`pan:${pan}`);
    const ph = normalisePhone(p.phone);
    if (ph !== null) keys.push(`ph:${ph}`);
    const e = normaliseEmail(p.email);
    if (e !== null) keys.push(`e:${e}`);
    const ad = normaliseAddress(p.address);
    if (ad !== null) keys.push(`ad:${ad}`);
  }
  return keys;
}

/** REQ-AO-05: A matches B and B matches C is one cluster of three. Confidence is the strongest pair; fields the union. */
export function clusterPairs(pairs: readonly PairMatch[]): Cluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  const union = (x: string, y: string) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const pair of pairs) {
    if (!parent.has(pair.a)) parent.set(pair.a, pair.a);
    if (!parent.has(pair.b)) parent.set(pair.b, pair.b);
    union(pair.a, pair.b);
  }
  const groups = new Map<string, { members: Set<string>; confidence: number; fields: Set<DuplicateMatchField> }>();
  for (const pair of pairs) {
    const root = find(pair.a);
    const group = groups.get(root) ?? { members: new Set<string>(), confidence: 0, fields: new Set<DuplicateMatchField>() };
    group.members.add(pair.a);
    group.members.add(pair.b);
    group.confidence = Math.max(group.confidence, pair.confidence);
    for (const f of pair.fields) group.fields.add(f);
    groups.set(root, group);
  }
  return [...groups.values()].map((g) => ({ members: [...g.members].sort(), confidence: g.confidence, fields: orderFields([...g.fields]) }));
}

/** The cluster's identity across pulls: its members and what they matched on. */
export function clusterSignature(cluster: Cluster): string {
  return `${cluster.members.join('+')}|${cluster.fields.join(',')}`;
}
