import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@typeward\/texlive-wasm\/tauri$/,
        replacement: fileURLToPath(new URL('./src/tauri.ts', import.meta.url)),
      },
      {
        find: /^@typeward\/texlive-wasm$/,
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      thresholds: { statements: 85, branches: 75, functions: 85, lines: 85 },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/node-worker.ts',
        'src/node.ts',
        'src/core/node-endpoint.ts',
      ],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
