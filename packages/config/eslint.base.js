import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Shared flat config. Apps extend this and add their own boundary rules.
 */
export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // CLAUDE.md §4: no `any`, no non-null assertions on API data.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // CLAUDE.md §6: never silently swallow an error.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // CLAUDE.md §3: no emojis anywhere, including code comments.
      // \p{Extended_Pictographic} covers the emoji blocks without catching
      // ordinary punctuation or accented Latin.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\p{Extended_Pictographic}/u]',
          message: 'No emojis (CLAUDE.md §3). Use a Phosphor icon.',
        },
      ],
    },
  },
  {
    // Test files legitimately reach for loose typing against fixtures.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle/**', '**/coverage/**'],
  },
);

/**
 * Every module that will ever live under `src/modules/`. The three that do not
 * exist yet are listed anyway, because the boundary has to be enforced from the
 * first line of code, not retrofitted once there is something to separate.
 *
 * Adding a module means adding it here. That is deliberate: a new module is a
 * new boundary, and it should be a conscious act rather than a side effect of
 * creating a directory.
 *
 * `erp` was the original placeholder for one module. Technical design `09` §1
 * splits that work across `sales` and `purchase` instead -- a purchase order
 * and a sales order are different documents, owned by different roles, and
 * `08` REQ-P-05 names the three paths individually. Naming them separately here
 * is what stops `modules/sales` importing `modules/purchase` directly on the
 * day both exist.
 */
export const API_MODULES = ['attendance', 'crm', 'sales', 'purchase'];

/**
 * Technical design §1: `modules/*` may import `platform/*`; `platform/*` must
 * never import `modules/*`; modules must never import each other.
 *
 * `no-restricted-imports` matches the literal specifier string, which is the
 * subtlety here. A sibling import from inside `modules/crm/` is written
 * `../attendance/thing` and contains no `modules/` segment at all, so a
 * pattern like `**\/modules\/**` silently misses exactly the violation it was
 * written to catch. Each module therefore gets its own rule naming its
 * siblings in both the alias form and the relative form.
 */
export const moduleBoundaries = [
  {
    files: ['src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '@/modules/*', '@/modules/**', '../modules/**'],
              message:
                'platform/ must never import from modules/ (technical design §1). ' +
                'If attendance needs to hand something to the platform, invert it: ' +
                'the platform defines the interface, the module implements it.',
            },
          ],
        },
      ],
    },
  },
  ...API_MODULES.map((self) => {
    const siblings = API_MODULES.filter((m) => m !== self);
    return {
      files: [`src/modules/${self}/**/*.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: siblings.flatMap((other) => [
                  `**/modules/${other}`,
                  `**/modules/${other}/**`,
                  `@/modules/${other}`,
                  `@/modules/${other}/**`,
                  // Relative sibling escapes, at any nesting depth.
                  `../${other}`,
                  `../${other}/**`,
                  `../../${other}`,
                  `../../${other}/**`,
                  `../../../${other}`,
                  `../../../${other}/**`,
                ]),
                message:
                  `Module "${self}" must not import module ${siblings.map((s) => `"${s}"`).join(' or ')} ` +
                  '(technical design §1). Modules communicate through the platform event bus. ' +
                  'Within your own module, use a relative import.',
              },
            ],
          },
        ],
      },
    };
  }),
];
