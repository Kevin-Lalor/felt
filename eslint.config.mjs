// Flat ESLint config. The load-bearing rules: Math.random is BANNED in the
// engine and server (CLAUDE.md hard rule 3) — CI greps for it too, this makes
// the editor catch it first. Hex colours are banned in web components (rule 7).
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', '**/*.js', '**/*.mjs'],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error', // CLAUDE.md style: no `any`
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/tokens/build.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }, // pre-existing scaffold tool
  },
  {
    files: ['packages/engine/src/**/*.ts', 'apps/server/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Hard rule 3: use node:crypto randomInt / the HMAC stream, never Math.random.',
        },
      ],
    },
  },
  {
    files: ['apps/web/src/components/**/*.tsx', 'apps/web/src/components/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message: 'Hard rule 7: no raw colours in components — use a semantic token.',
        },
      ],
    },
  },
];
