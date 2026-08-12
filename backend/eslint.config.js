import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
  files: ['src/accounting/**/*.js', 'src/reporting/**/*.js'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "BinaryExpression[operator='+']",
        message: 'No raw + on money. Use add() from lib/money.js.',
      },
      {
        selector: "CallExpression[callee.name='parseFloat']",
        message: 'No parseFloat on money. Use dec() from lib/money.js.',
      },
      {
        selector: "CallExpression[callee.name='Number']",
        message: 'No Number() on money. Use dec() from lib/money.js.',
      },
    ],
  },
},
// A lint rule that only watches two folders (accounting/ and reporting/) — folders that don't exist yet, they'll be created Day 3+. Inside those folders only, it blocks:

// plain + (like a + b)
// parseFloat(x)
// Number(x)

];
