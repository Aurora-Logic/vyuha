import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';

import { AppShell } from '@/app/layout/app-shell';
import { PageHeader } from '@/components/shared/page-header';
import { renderWithProviders } from '@/test-support/render-shell';
import { setViewportMatches } from '@/test-support/setup';
import { ROLE_PERMISSION_MATRIX, type SystemRoleName } from '@vyuha/shared';

import appSource from '@/App.tsx?raw';
import dispatchPaperSource from '@/features/sales/dispatch-paper-page.tsx?raw';
import documentEditorSource from '@/features/documents/document-editor.tsx?raw';
import estimateEditorSource from '@/features/sales/estimate-editor-page.tsx?raw';
import grnPaperSource from '@/features/purchase/grn-paper-page.tsx?raw';
import invoiceEditorSource from '@/features/sales/invoice-editor-page.tsx?raw';
import packingSlipSource from '@/features/sales/packing-slip-page.tsx?raw';
import paperPageSource from '@/features/documents/paper-page.tsx?raw';
import purchaseOrderEditorSource from '@/features/purchase/purchase-order-editor-page.tsx?raw';
import salesOrderEditorSource from '@/features/sales/sales-order-editor-page.tsx?raw';
import { ALL_NAV_ITEMS } from '@/lib/nav';

import {
  ALL_STEPS,
  ANCHORS,
  anchorFor,
  guidedRoutes,
  introFor,
  introForPath,
  resolvePageSteps,
  resolveSteps,
  SHELL_ANCHORS,
} from './tour-steps';

/**
 * The guided tour finds its targets through `data-guide` attributes on
 * ordinary controls. That coupling is weak by design — an attribute, not a
 * structure — but its failure mode is silent: a refactor drops an attribute,
 * the step is skipped at runtime, and nothing goes red.
 *
 * `scripts/check-guide-anchors.mjs` catches a *deleted* attribute by reading
 * the source. It cannot tell how many elements actually render, which is the
 * other half of the contract: a step whose selector matches two elements
 * highlights whichever the DOM happens to return first. That is what this
 * file is for.
 */

function renderShell(page = <PageHeader description="A test screen." />) {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={page} />
      </Route>
    </Routes>,
  );
}

function countAnchor(name: string): number {
  return document.querySelectorAll(`[data-guide="${name}"]`).length;
}

/**
 * Every path App.tsx serves, and which of them render inside the shell.
 *
 * Parsed from the source rather than duplicated here. A list of routes kept in
 * a test is a list that goes stale, and going stale silently is the exact
 * failure this file exists to catch.
 */
// Vite's `?raw` rather than node:fs. The web tsconfig types only `vite/client`
// on purpose, so `process` is not in scope here, and widening it for one test
// would be a project-wide change to serve a single file.
const APP_SOURCE: string = appSource;

const ROUTER_PATHS = new Set([
  // The dashboard is an index route and carries no `path`, so the regex below
  // cannot see it. Added explicitly rather than by loosening the pattern.
  ...(APP_SOURCE.includes('<Route index') ? ['/'] : []),
  ...[...APP_SOURCE.matchAll(/path="([^"]+)"/gu)]
    .map((m) => m[1])
    .filter((p): p is string => Boolean(p))
    .filter((p) => p !== '*')
    .map((p) => (p.startsWith('/') ? p : `/${p}`)),
]);

/**
 * Routes served inside `<Route element={<AppShell />}>`, which are the ones
 * that show the header pin and therefore promise a guide. `print/:kind/:id`
 * sits outside the shell and is excluded for that reason, not overlooked.
 */
const SHELL_ROUTES = new Set(
  [...APP_SOURCE.slice(APP_SOURCE.indexOf('<AppShell />')).matchAll(/path="([^"]+)"/gu)]
    .map((m) => m[1])
    .filter((p): p is string => Boolean(p))
    .filter((p) => p !== '*' && p !== 'patterns')
    .map((p) => (p.startsWith('/') ? p : `/${p}`)),
);

/** A concrete path for a pattern, so the runtime resolver can be asked. */
function exampleFor(route: string): string {
  return route.replace(/:[^/]+/gu, 'example-id');
}

describe('guided tour anchors', () => {
  it('resolves every shell anchor to exactly one element on a desktop shell', () => {
    renderShell();

    for (const anchor of SHELL_ANCHORS) {
      expect(countAnchor(anchor), `[data-guide="${anchor}"]`).toBe(1);
    }
  });

  it('resolves every shell anchor to exactly one element on a phone', () => {
    // useIsMobile reads matchMedia, which swaps the account menu from a
    // dropdown to a sheet — two different elements carrying the same anchor,
    // and the one place a duplicate could plausibly appear.
    setViewportMatches(true);
    renderShell();

    for (const anchor of SHELL_ANCHORS) {
      expect(countAnchor(anchor), `[data-guide="${anchor}"]`).toBe(1);
    }
  });

  it('treats furniture anchors as optional rather than required', () => {
    // A screen legitimately has no table, or two. The shell test above asserts
    // singularity only for the anchors that are singular by construction; this
    // records that the rest are deliberately not in that set, so nobody
    // "fixes" the gap by adding them.
    const furniture = Object.values(ANCHORS).filter((a) => !SHELL_ANCHORS.includes(a));

    expect(furniture).toEqual([
      // A screen anchor, not furniture: the document editor renders no
      // PageHeader, so the seven document screens are anchored on its toolbar
      // instead. Absent everywhere else, which is why it is not in the shell
      // set either.
      'screen.document',
      'screen.search',
      'screen.table',
      'screen.table-cards',
      'screen.pagination',
    ]);
  });

  it('names no anchor that the registry does not use', () => {
    const used = new Set(ALL_STEPS.flatMap((s) => [s.anchor, s.mobileAnchor].filter(Boolean)));

    for (const anchor of Object.values(ANCHORS)) {
      expect(used.has(anchor), `${anchor} is declared but no step uses it`).toBe(true);
    }
  });

  it('gives every step an anchor that is declared in ANCHORS', () => {
    const declared = new Set<string>(Object.values(ANCHORS));

    for (const step of ALL_STEPS) {
      expect(declared.has(step.anchor), `${step.id} -> ${step.anchor}`).toBe(true);
      if (step.mobileAnchor) {
        expect(declared.has(step.mobileAnchor), `${step.id} -> ${step.mobileAnchor}`).toBe(true);
      }
    }
  });
});

describe('guided tour length', () => {
  /*
   * A regression guard on a real bug, not a restatement of the registry.
   *
   * The tour once started before `SessionGate` had written the permission set,
   * froze a five-step list for an administrator entitled to twenty-one, and
   * silently filtered every screen step away as unpermitted. Nothing about the
   * code looked wrong. These numbers are what "it filtered correctly" means,
   * so a filter that silently empties itself fails here rather than in front
   * of somebody taking the tour.
   */
  // Recounted when the reports module returned as the observed areas (owner,
  // 26 Aug 2026), and again when the CFO's credit screens joined it: each
  // step sits behind its own key, so a role gains exactly the pages its
  // permissions open -- the sales roles the work lists, the credit-sighted
  // roles the receivable book, Employee and Purchase none at all.
  //
  // The task dashboard (REQ-V-11) moved every role holding a task view key,
  // which after P7-2 is all of them but Warehouse -- the one role with no
  // task keys, and it did not move. The CRM dashboard was removed on the
  // owner's word (31 Aug 2026), taking a step back off the four deal-sighted
  // roles and nobody else.
  const EXPECTED: Record<SystemRoleName, { desktop: number; phone: number }> = {
    Employee: { desktop: 14, phone: 13 },
    Operations: { desktop: 23, phone: 22 },
    HR: { desktop: 28, phone: 27 },
    Admin: { desktop: 79, phone: 78 },
    // The CRM roles hold no attendance keys (D-15: they sit beside Employee),
    // so the tour they get is the shell plus whatever the masters key unlocks.
    Sales: { desktop: 36, phone: 35 },
    'Sales manager': { desktop: 49, phone: 48 },
    'Relationship manager': { desktop: 35, phone: 34 },
    Purchase: { desktop: 16, phone: 15 },
    Accounts: { desktop: 46, phone: 45 },
    Warehouse: { desktop: 14, phone: 13 },
  };

  for (const [role, expected] of Object.entries(EXPECTED) as [
    SystemRoleName,
    { desktop: number; phone: number },
  ][]) {
    it(`gives ${role} ${String(expected.desktop)} steps on a desktop`, () => {
      const granted = new Set(ROLE_PERMISSION_MATRIX[role]);
      expect(resolveSteps(granted, false)).toHaveLength(expected.desktop);
    });

    it(`gives ${role} ${String(expected.phone)} steps on a phone`, () => {
      const granted = new Set(ROLE_PERMISSION_MATRIX[role]);
      // One fewer: the shortcut sheet is a desktop-only control, and its step
      // declares mobileBehaviour: 'skip' rather than pointing at nothing.
      expect(resolveSteps(granted, true)).toHaveLength(expected.phone);
    });
  }

  it('never offers a step whose permission the session lacks', () => {
    const granted = new Set(ROLE_PERMISSION_MATRIX.Employee);

    for (const step of resolveSteps(granted, false)) {
      if (step.permission) expect(granted.has(step.permission)).toBe(true);
    }
  });

  it('gives a session with no permissions the shell steps and nothing else', () => {
    const steps = resolveSteps(new Set(), false);

    expect(steps.every((s) => !s.permission)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });
});

describe('the per-screen guide', () => {
  const admin = new Set(ROLE_PERMISSION_MATRIX.Admin);
  const present = (anchors: string[]) => (a: string) => anchors.includes(a);

  it('answers "what is this screen" without walking the whole product', () => {
    /*
     * The complaint this scope exists to answer: reaching Approvals in the
     * whole-product tour costs sixteen steps, and somebody standing on
     * Approvals wanting to know what it does should pay none of them.
     */
    const whole = resolveSteps(admin, false);
    const stepsToReachIt = whole.findIndex((s) => s.id === 'screen.approvals') + 1;
    const page = resolvePageSteps('/approvals', admin, false, present([]));

    // Asserted as a relationship rather than a literal, so adding a screen
    // does not fail this for the wrong reason. Today it is 10 against 1.
    expect(stepsToReachIt).toBeGreaterThan(5);
    expect(page.length).toBeLessThan(stepsToReachIt);
    expect(page[0]?.id).toBe('screen.approvals');
  });

  it('includes only the furniture the screen actually renders', () => {
    const bare = resolvePageSteps('/approvals', admin, false, present([]));
    const withTable = resolvePageSteps('/approvals', admin, false, present(['screen.table']));
    const full = resolvePageSteps(
      '/employees',
      admin,
      false,
      present(['screen.search', 'screen.table', 'screen.pagination']),
    );

    expect(bare.map((s) => s.id)).toEqual(['screen.approvals']);
    expect(withTable.map((s) => s.id)).toEqual(['screen.approvals', 'furniture.table']);
    expect(full.map((s) => s.id)).toEqual([
      'screen.employees',
      'furniture.search',
      'furniture.table',
      'furniture.pagination',
    ]);
  });

  it('keeps furniture out of the whole-product tour', () => {
    // Sixteen screens each repeating "this is the table" is what would make
    // the long tour unbearable, so furniture belongs to the page scope only.
    expect(resolveSteps(admin, false).some((s) => s.furniture)).toBe(false);
  });

  it('gives nothing for a route the tour does not introduce', () => {
    // /profile used to be the example here and now has a guide of its own, so
    // the case needs a path the router genuinely does not serve.
    expect(resolvePageSteps('/nonsense', admin, false, present([]))).toEqual([]);
    expect(resolvePageSteps('/nope/deeper', admin, false, present([]))).toEqual([]);
  });

  it('falls back to the list for a row selected within it', () => {
    // /crm/deals and /crm/deals/abc are the same screen with a panel open, so
    // the detail path resolves to the list's guide rather than to nothing.
    const detail = resolvePageSteps('/crm/deals/abc123', admin, false, present([]));

    expect(detail.map((s) => s.id)).toEqual(['screen.crm-deals']);
  });

  it('prefers an explicit entry over the parent fallback', () => {
    // An editor is not its list with a panel open, so /sales/orders/new must
    // get the editor's own step and not the sales-order list's.
    const editor = resolvePageSteps('/sales/orders/new', admin, false, present([]));

    expect(editor.map((s) => s.id)).toEqual(['screen.sales-order-editor']);
  });

  it('refuses a screen the session cannot open', () => {
    const employee = new Set(ROLE_PERMISSION_MATRIX.Employee);

    expect(resolvePageSteps('/audit', employee, false, present(['screen.table']))).toEqual([]);
    expect(resolvePageSteps('/punch', employee, false, present([])).map((s) => s.id)).toEqual([
      'screen.punch',
    ]);
  });

  it('points the table step at the card list on a phone', () => {
    const desktop = resolvePageSteps('/employees', admin, false, present(['screen.table']));
    const phone = resolvePageSteps('/employees', admin, true, present(['screen.table']));

    const desktopTable = desktop.find((s) => s.id === 'furniture.table');
    const phoneTable = phone.find((s) => s.id === 'furniture.table');

    expect(desktopTable).toBeDefined();
    expect(phoneTable).toBeDefined();
    // The desktop table and the phone's card list are separate elements, both
    // always in the DOM with CSS deciding which is visible — so the guide has
    // to choose by width rather than by presence.
    expect(desktopTable && anchorFor(desktopTable, false)).toBe('screen.table');
    expect(phoneTable && anchorFor(phoneTable, true)).toBe('screen.table-cards');
  });
});

describe('coverage of the navigation', () => {
  /*
   * The bug this exists to prevent, which shipped once already.
   *
   * "Guide to this screen" is offered on every screen. A route with no intro
   * resolves to an empty step list, `start()` returns early, and pressing the
   * control does nothing at all — no error, no message. Seven screens were in
   * that state at once, including the Dashboard, which is where everybody
   * lands. Adding a screen and forgetting its guide has to fail here rather
   * than in front of the person who pressed the button.
   */
  it('introduces every screen reachable from the navigation', () => {
    const missing = ALL_NAV_ITEMS.map((item) => item.to).filter((route) => !introFor(route));

    expect(missing, `no guide for: ${missing.join(', ')}`).toEqual([]);
  });

  it('gates each screen exactly as the navigation gates it', () => {
    // A guide the person can start for a screen the sidebar hides would walk
    // them into a refusal; one gated more tightly than its screen is dead copy.
    for (const item of ALL_NAV_ITEMS) {
      const intro = introFor(item.to);
      if (!intro) continue;
      expect(intro.permission, `${item.to}`).toBe(item.permission);
    }
  });

  it('names a route that actually exists for every intro', () => {
    for (const route of guidedRoutes()) {
      expect(ROUTER_PATHS.has(route), `${route} is guided but the router serves no such path`).toBe(
        true,
      );
    }
  });

  /*
   * The gap the navigation-only check could not see.
   *
   * `ALL_NAV_ITEMS` is the sidebar, and the sidebar is not the product: detail
   * pages, the four document editors, the three paper views and the account
   * screens are all routed, all wear the shell, and all show the header pin.
   * Twenty-two of them offered a button that did nothing, and the earlier test
   * passed the whole time because it was only ever asked about the sidebar.
   *
   * Read from App.tsx rather than from a list kept here, so a route added
   * there is a route this test knows about.
   */
  it('guides every screen the router serves inside the shell', () => {
    const missing = [...SHELL_ROUTES].filter((route) => !introForPath(exampleFor(route)));

    expect(missing, `no guide for: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the document screens', () => {
  /*
   * Seven screens, one anchor, and a chain that has to hold.
   *
   * None of these renders a `PageHeader`, so `screen.header` is absent and
   * they are anchored on the `DocumentEditor` toolbar instead. Three of them
   * (`/new` on estimates, sales orders and purchase orders) were driven in a
   * browser and start their guide. The other four need a saved document to get
   * past their loading state, which a stubbed API cannot produce — so what
   * they rest on is asserted here instead of assumed: every one of them
   * renders `DocumentEditor`, and `DocumentEditor` carries the anchor.
   */
  const PAGES: [string, string][] = [
    ['estimate editor', estimateEditorSource],
    ['sales order editor', salesOrderEditorSource],
    ['invoice editor', invoiceEditorSource],
    ['purchase order editor', purchaseOrderEditorSource],
    ['paper page', paperPageSource],
    ['packing slip', packingSlipSource],
    ['dispatch paper', dispatchPaperSource],
    ['GRN paper', grnPaperSource],
  ];

  it.each(PAGES)('%s reaches DocumentEditor', (_name, source) => {
    // The paper views go through paper-page, which itself renders the editor,
    // so either the import or that wrapper counts as reaching it.
    const reachesIt = source.includes('DocumentEditor') || source.includes('PaperPage');

    expect(reachesIt).toBe(true);
  });

  it('puts the anchor on DocumentEditor itself', () => {
    expect(documentEditorSource).toContain(`data-guide="${ANCHORS.screenDocument}"`);
  });

  it('gives every document route a step pointing at that anchor', () => {
    const documentRoutes = [
      '/sales/estimates/new',
      '/sales/orders/new',
      '/sales/invoices/x',
      '/purchase/orders/new',
      '/sales/packs/x',
      '/sales/dispatches/x',
      '/purchase/grns/x',
    ];

    for (const route of documentRoutes) {
      expect(introForPath(route)?.anchor, route).toBe(ANCHORS.screenDocument);
    }
  });
});
