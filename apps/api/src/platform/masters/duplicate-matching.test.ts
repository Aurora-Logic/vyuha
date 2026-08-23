import { describe, expect, it } from 'vitest';

import { blockKeys, clusterPairs, clusterSignature, nameSimilarity, normaliseAddress, normaliseName, normalisePhone, panOf, scoreItems, scoreParties, type PartyRecord } from './duplicate-matching.js';

const party = (over: Partial<PartyRecord> & { id: string; name: string }): PartyRecord => ({ alias: null, gstin: null, phone: null, email: null, address: null, ...over });

describe('normalisation', () => {
  it('folds case, punctuation, spacing, "&" and the legal form -- but never what the firm trades in', () => {
    expect(normaliseName('Asha Traders Pvt. Ltd.')).toBe('ashatraders');
    expect(normaliseName('ASHA  TRADERS PRIVATE LIMITED')).toBe('ashatraders');
    expect(normaliseName('Asha Traders P Ltd')).toBe('ashatraders');
    expect(normaliseName('Behar & Sons')).toBe('beharandsons');
    expect(normaliseName('Behar and Sons')).toBe('beharandsons');
    expect(normaliseName('Limited')).toBe('limited');
    // The trade descriptor stays: folding it made every "Asha <something>" one firm,
    // and a cluster is transitive, so one shared first word chained them all together.
    expect(normaliseName('Asha Industries')).toBe('ashaindustries');
    expect(normaliseName('Asha Enterprises')).not.toBe(normaliseName('Asha Traders'));
  });

  it('does not read two names it cannot transcribe as the same name', () => {
    expect(nameSimilarity('', '')).toBe(0);
    expect(scoreParties(party({ id: 'a', name: 'आशा ट्रेडर्स' }), party({ id: 'b', name: '株式会社ベハール' }))).toBeNull();
  });

  it('reads phones by their last ten digits, PAN out of a GSTIN, and an address by pincode and first line', () => {
    expect(normalisePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalisePhone('0-9876-543210')).toBe('9876543210');
    expect(normalisePhone('12')).toBeNull();
    expect(panOf('27AAAPL1234C1ZV')).toBe('AAAPL1234C');
    expect(panOf('bad')).toBeNull();
    expect(normaliseAddress('12, MG Road, Nashik 422001')).toBe('422001:12');
    expect(normaliseAddress('12 MG Road\nNashik - 422001')).toBe('422001:12mgroad');
    expect(normaliseAddress('No pincode here')).toBeNull();
  });

  it('tells a mistyped name from a different one', () => {
    expect(nameSimilarity('igatpuricables', 'igatpuricable')).toBeGreaterThanOrEqual(0.8);
    expect(nameSimilarity('asha', 'usha')).toBeLessThan(0.8);
  });
});

describe('scoring', () => {
  it('is certainty on a GSTIN or PAN match whatever the name says (D-56)', () => {
    const a = party({ id: 'a', name: 'Asha Traders', gstin: '27AAAPL1234C1ZV' });
    const b = party({ id: 'b', name: 'Completely Different Co', gstin: '27AAAPL1234C1ZV' });
    expect(scoreParties(a, b)).toEqual({ a: 'a', b: 'b', confidence: 1, fields: ['gstin'] });
    const c = party({ id: 'c', name: 'Another', gstin: '29AAAPL1234C1Z5' });
    expect(scoreParties(a, c)?.fields).toEqual(['pan']);
    expect(scoreParties(a, c)?.confidence).toBe(1);
  });

  it('reads Pvt Ltd and Private Limited as one name, and adds contact fields on top', () => {
    const a = party({ id: 'a', name: 'Asha Traders Pvt Ltd', phone: '9876543210' });
    const b = party({ id: 'b', name: 'Asha Traders Private Limited', phone: '+91 98765 43210' });
    const match = scoreParties(a, b);
    expect(match?.fields).toEqual(['name', 'phone']);
    expect(match?.confidence).toBeGreaterThanOrEqual(0.75);
    expect(scoreParties(party({ id: 'a', name: 'Asha' }), party({ id: 'b', name: 'Usha' }))).toBeNull();
    // Two firms that share only a first word are two firms.
    expect(scoreParties(party({ id: 'a', name: 'Asha Traders' }), party({ id: 'b', name: 'Asha Industries' }))).toBeNull();
  });

  it('reads the same part number under two names as the strongest item signal', () => {
    const match = scoreItems({ id: 'x', name: 'Cat6 cable box', alias: 'CAT6-305', unit: 'BOX', parentGroup: 'Cables' }, { id: 'y', name: 'CAT 6 Cable 305m', alias: 'cat6 305', unit: 'BOX', parentGroup: 'Cables' });
    expect(match?.fields).toEqual(['alias', 'unit', 'group']);
    expect(match?.confidence).toBe(1);
    expect(scoreItems({ id: 'x', name: 'RCCB 40A', alias: null, unit: 'NOS', parentGroup: 'Switchgear' }, { id: 'y', name: 'MCB 6A', alias: null, unit: 'NOS', parentGroup: 'Switchgear' })).toBeNull();
  });
});

describe('blocking and clustering', () => {
  it('shares a block on any agreeing key', () => {
    const keys = blockKeys('party', party({ id: 'a', name: 'Asha Traders Pvt Ltd', gstin: '27AAAPL1234C1ZV', phone: '9876543210' }));
    expect(keys).toEqual(expect.arrayContaining(['n:ashatraders', 'p:asha', 'g:27AAAPL1234C1ZV', 'pan:AAAPL1234C', 'ph:9876543210']));
  });

  it('joins A-B and B-C into one cluster of three, strongest pair as confidence, fields the union (REQ-AO-05)', () => {
    const clusters = clusterPairs([
      { a: 'a', b: 'b', confidence: 0.85, fields: ['name'] },
      { a: 'b', b: 'c', confidence: 1, fields: ['gstin'] },
      { a: 'x', b: 'y', confidence: 0.8, fields: ['alias'] },
    ]);
    expect(clusters).toHaveLength(2);
    const big = clusters.find((c) => c.members.length === 3);
    expect(big).toEqual({ members: ['a', 'b', 'c'], confidence: 1, fields: ['gstin', 'name'] });
    expect(clusterSignature(big ?? { members: [], confidence: 0, fields: [] })).toBe('a+b+c|gstin,name');
  });
});
