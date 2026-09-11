import js from '@eslint/js';
import globals from 'globals';

export default [
  // Vue/Vite and temporary build outputs are not backend lint inputs.
  { ignores: ['public/**', '.tmp/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // Relaxations match the codebase's existing idiom (unused handler args,
    // deliberate empty catches); keeping the gate correctness-only minimizes
    // churn on future upstream merges.
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
