import js from '@eslint/js';
import globals from 'globals';

export default [
  // Prisma's generated client is bundled output, not our source — never lint it.
  { ignores: ['src/generated/**'] },
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
  files: [
    'src/lib/accounting/**/*.js',
    'src/lib/banking/**/*.js',
    'src/lib/invoices/**/*.js',
    'src/routes/reports.js',
  ],
  // Tests compute independent expected values with plain JS on purpose.
  ignores: ['**/*.test.js'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        // `x + 1` is index/counter arithmetic, not money.
        selector: "BinaryExpression[operator='+']:not([right.type='Literal'][right.value=1])",
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
];
