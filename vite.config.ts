import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import wasm from 'vite-plugin-wasm';
import dts from 'vite-plugin-dts';

export default defineConfig({
  // Relative base so the worker asset URL emitted into dist/index.js stays
  // relative to the module ("assets/worker-*.js"), not root-absolute
  // ("/assets/worker-*.js") — consumers bundling the lib (Typeward app)
  // can't resolve a root-absolute asset path inside node_modules.
  base: './',
  server: { watch: { ignored: ['**/engine/**', '**/vendor/**', '**/rust/target/**'] } },
  plugins: [
    wasm(),
    dts({
      entryRoot: 'src',
      outDir: 'dist',
      insertTypesEntry: true,
      rollupTypes: false,
      exclude: ['**/*.test.ts', 'test/**'],
    }),
  ],
  build: {
    target: 'es2022',
    lib: {
      entry: {
        node: resolve(__dirname, 'src/node.ts'),
        'node-worker': resolve(__dirname, 'src/node-worker.ts'),
        index: resolve(__dirname, 'src/index.ts'),
        tauri: resolve(__dirname, 'src/tauri.ts'),
        worker: resolve(__dirname, 'src/core/worker.ts'),
        manifest: resolve(__dirname, 'src/core/manifest.ts'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entry) => `${entry}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: [
        'comlink',
        'xz-decompress',
        '@tauri-apps/plugin-fs',
        'node:fs',
        'node:path',
        'node:url',
        'node:worker_threads',
      ],
      output: {
        preserveModules: false,
      },
    },
    sourcemap: true,
    minify: false,
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  // Test config lives in vitest.config.ts (vitest does not merge this file
  // when a dedicated config exists).
});
