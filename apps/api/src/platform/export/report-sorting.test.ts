import { ALL_REPORTS, REPORT_DEFINITIONS, sortableFields, type ReportKey } from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness } from '../../test-support/api-harness.js';

import { ReportSourceRegistry } from './report-source.registry.js';

/**
 * A column that says it can be sorted can be sorted.
 *
 * The catalogue in `@vyuha/shared` decides which columns show a sort control;
 * the source decides what the ORDER BY does. Nothing joined the two, and four
 * sources had grown `sort === 'x' ? … : sort === 'y' ? …` chains where a
 * column could be advertised and have no arm: the header showed an arrow, the
 * click changed the URL, the rows came back in the order they were already
 * in. `ratePct` on both returns reports and `billDate` on ageing were exactly
 * that, and a chain that matched only the bare name did it to every
 * descending click.
 *
 * Sources now declare what they implement, so this holds the two lists
 * against each other for every report in the build.
 */
let harness: ApiHarness;
let registry: ReportSourceRegistry;

const ORG_ID = '01900000-0000-7000-8000-00000000f0da';

/** The fields a sort spec names, `-` and commas stripped. */
function fieldsOf(spec: string): string[] {
  return spec.split(',').map((term) => term.trim().replace(/^-/, '')).filter((term) => term.length > 0);
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Report Sorting Org');
  registry = harness.resolve(ReportSourceRegistry);
});

afterAll(async () => {
  await harness.close();
});

describe('every sortable column has an ORDER BY behind it', () => {
  it('registers a source for every report in the catalogue', () => {
    const orphans = ALL_REPORTS.filter((report) => registry.sourceFor(report.key) === null);
    expect(orphans.map((r) => r.key)).toEqual([]);
    expect(ALL_REPORTS.length).toBeGreaterThan(50);
  });

  it.each(ALL_REPORTS.map((report) => report.key))('%s implements every field its columns advertise', (key: ReportKey) => {
    const source = registry.require(key);
    const implemented = new Set(source.sortableFields(key));
    const advertised = sortableFields(key);
    expect([...new Set(advertised)].filter((field) => !implemented.has(field))).toEqual([]);
  });

  it.each(ALL_REPORTS.map((report) => report.key))('%s can be ordered by its own default sort', (key: ReportKey) => {
    const source = registry.require(key);
    const implemented = new Set(source.sortableFields(key));
    // The default is applied the same way a click is, so a default naming a
    // field the source does not implement is silently ignored too -- and then
    // the report's stated ordering is not the one it opens in.
    const missing = fieldsOf(REPORT_DEFINITIONS[key].defaultSort).filter((field) => !implemented.has(field));
    expect(missing).toEqual([]);
  });
});
