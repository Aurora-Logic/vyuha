import { describe, expect, it } from 'vitest';

/**
 * A screen does not decide how tall a control is on a phone.
 *
 * Buttons, toggles and select triggers are drawn at their desktop height and
 * grow an invisible 44px target through a pseudo-element; fields and rows
 * are raised by the coarse-pointer floor in index.css. Either way the
 * primitive owns it. Before this test, seventeen call sites had put
 * `pointer-coarse:min-h-11` on their own buttons and a hundred and sixty
 * more had put `pointer-coarse:h-11` on their own inputs, selects and
 * toggle items, so the dispatch dialog's controls were one height and the
 * leave page's another. The overrides are gone; this keeps them from
 * coming back one screen at a time, which is how they arrived.
 *
 * Sources are read through Vite's glob so the test needs no Node typings in
 * the browser-typed app config.
 */
const SOURCES = import.meta.glob<string>(
  ['/src/app/**/*.tsx', '/src/components/shared/**/*.tsx', '/src/features/**/*.tsx', '!**/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Controls that are deliberately not button-height, each for a reason the
 * screen states in place: the 64px punch photo and attachment thumbnails, the calculator
 * keypad's 44px keys on every pointer, the profile page's multi-line fold
 * rows, the punch page's 56px hero action, the design rail's upload tile,
 * the 56px bottom bar whose More button matches its links, and the report
 * catalogue's cards (a name over a two-line description, the whole card
 * the target).
 */
const ALLOWED = new Set([
  '/src/features/attendance/day-punches.tsx',
  '/src/components/shared/attachment-panel.tsx',
  '/src/features/calculator/calculator-panel.tsx',
  '/src/features/profile/profile-page.tsx',
  '/src/features/punch/punch-page.tsx',
  '/src/features/documents/design-rail.tsx',
  '/src/components/shared/mobile-bottom-nav.tsx',
]);

/**
 * Any explicit height on a Button except min-h-11, which is the floor itself
 * and what a 44px row tile says; any coarse-pointer growth on any of the
 * listed controls.
 */
const BUTTON_HEIGHT = /(^|\s)(h-\d+|min-h-(?!11(?=\s|$))\S+|size-\d+)(?=\s|$)/;
const COARSE_OVERRIDE = /(^|\s)pointer-coarse:(h|min-h|size|py|after)[:-]\S*(?=\s|$)/;
// `=>` inside an earlier prop is not the end of the tag; without this a
// className after an onClick arrow was never read.
const CONTROL_TAG = /<(Button|SelectTrigger|Toggle|ToggleGroupItem|TabsTrigger|Input|Textarea|InputGroup|CommandItem|DropdownMenuItem)\b(?:=>|[^>])*?>/gs;
const CLASS_NAME = /className="([^"]*)"/;

describe('Button height is owned by the primitive', () => {
  it('no screen sets a height on a Button, or coarse-pointer growth on any control', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      if (ALLOWED.has(file)) continue;
      for (const tag of source.match(CONTROL_TAG) ?? []) {
        const classes = CLASS_NAME.exec(tag)?.[1];
        const isButton = tag.startsWith('<Button');
        if (classes && (COARSE_OVERRIDE.test(classes) || (isButton && BUTTON_HEIGHT.test(classes)))) {
          const line = source.slice(0, source.indexOf(tag)).split('\n').length;
          offenders.push(`${file}:${line} ${classes}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans the screens at all', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });
});
