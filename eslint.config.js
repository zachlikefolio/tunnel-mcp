import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', '.superpowers/'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The MCP SDK server surface is intentionally loosely typed at the boundary.
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow intentionally-unused args/vars prefixed with `_`; ignore caught errors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Empty catch blocks are used deliberately for best-effort cleanup.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
