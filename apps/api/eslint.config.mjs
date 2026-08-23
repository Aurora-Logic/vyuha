import { base, moduleBoundaries } from '@vyuha/config/eslint';
import { orgScope } from '@vyuha/config/eslint-org-scope';

export default [
  ...base,
  ...moduleBoundaries,
  {
    // Owner's decision, 22 Aug 2026: the org-scoping invariant is enforced by
    // the build, not remembered by the reviewer. Tests, fixtures and the seed
    // are excluded because they deliberately act across organisations --
    // setting up a second tenant is how the isolation tests prove anything.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/test-support/**/*.ts'],
    plugins: { 'org-scope': orgScope },
    rules: {
      'org-scope/repository-is-org-bound': [
        'error',
        {
          // The escalation sweep is the one reader that is deliberately not
          // org-bound: it runs once for every organisation, reads ids only,
          // and every write it then makes goes through a scoped repository
          // with the org id the sweep returned. Binding it would turn one
          // indexed sweep into N. Its own doc comment says so at the class.
          allow: ['ApprovalSweepRepository'],
        },
      ],
    },
  },
  {
    // The SQL half is the owner's words exactly: "any raw `sql` block in a
    // repository without an `org_id`". The repository is the layer that owns
    // data access, so it is the layer where the invariant has to be local.
    // Services carry 124 more blocks in the same shape; see PENDING P-24.
    files: ['src/**/*.repository.ts'],
    ignores: ['src/**/*.test.ts'],
    plugins: { 'org-scope': orgScope },
    rules: {
      'org-scope/sql-names-org-id': 'error',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // Nest controllers and providers are instantiated by the framework, so
      // the class itself is never referenced by name in our own code.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
