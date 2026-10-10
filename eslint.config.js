const js = require('@eslint/js');
const globals = require('globals');

// Cross-runtime globals available in the Electron main process and tests.
const webGlobals = {
  fetch: 'readonly', URL: 'readonly', Response: 'readonly', Request: 'readonly',
  ReadableStream: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly', structuredClone: 'readonly'
};

module.exports = [
  { ignores: ['node_modules/**', 'release/**', 'outputs/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['src/main.js', 'src/preload.js', 'src/lib/**/*.js', 'test/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...webGlobals }
    }
  },
  {
    files: ['src/renderer.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...webGlobals }
    }
  },
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  }
];
