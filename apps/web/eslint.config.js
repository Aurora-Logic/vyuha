import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'scripts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true },
    },
    rules: {
      // CLAUDE.md §4: no `any`, no non-null assertions on API data.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // CLAUDE.md §3: no emojis anywhere. Icons only (-icons/react).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\p{Extended_Pictographic}/u]',
          message: 'No emojis (CLAUDE.md §3). Use a Phosphor icon.',
        },
        // CLAUDE.md §3 and 05-decisions: native date and time inputs are the
        // single most common place the shadcn-only rule gets broken. They
        // render differently on every browser and are unusable on mobile.
        {
          selector:
            'JSXOpeningElement[name.name="input"] JSXAttribute[name.name="type"][value.value=/^(date|time|datetime-local|month|week)$/]',
          message:
            'Never a native date/time input (CLAUDE.md §3). Compose shadcn Calendar + Popover, ' +
            'opening as a Sheet on small screens.',
        },
      ],

      // CLAUDE.md §3: feature code uses shadcn components, not raw controls.
      // Scoped below so the vendored components in components/ui are exempt.
      'no-restricted-syntax-placeholder': 'off',
    },
  },
  {
    // Feature code specifically: no raw form controls.
    files: ['src/app/**/*.tsx', 'src/features/**/*.tsx', 'src/components/shared/**/*.tsx'],
    rules: {
      'react/forbid-elements': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\p{Extended_Pictographic}/u]',
          message: 'No emojis (CLAUDE.md §3). Use a Phosphor icon.',
        },
        {
          selector:
            'JSXOpeningElement[name.name=/^(button|input|select|textarea|dialog|form)$/]',
          message:
            'No raw form controls in feature code (CLAUDE.md §3). Use the shadcn component, ' +
            'installed through the shadcn MCP.',
        },
      ],
    },
  },
  {
    // Context modules deliberately export a provider component alongside the
    // hooks that read it — splitting a registry's API across two files to
    // please fast refresh would make it harder to use, not safer.
    files: ['src/lib/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Vendored shadcn source. It is generated, updated via `shadcn add --diff`,
    // and deliberately not held to the feature-code rules above.
    files: ['src/components/ui/**', 'src/components/theme-provider.tsx', 'src/hooks/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'react-refresh/only-export-components': 'off',
      'no-restricted-syntax': 'off',
      // use-mobile.ts sets state directly in an effect. It is upstream code we
      // do not own; rewriting it around useSyncExternalStore would fork it from
      // the registry and break `shadcn add --diff` updates for a hook that runs
      // once on mount.
      'react-hooks/set-state-in-effect': 'off',
      // chart.tsx interpolates recharts' own tooltip name and value types,
      // which are unions that include a function, and asserts types recharts
      // has since narrowed upstream. Both are properties of the registry
      // source; patching them here would be reverted by the next
      // `shadcn add chart` without anybody noticing it had happened.
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
]);
