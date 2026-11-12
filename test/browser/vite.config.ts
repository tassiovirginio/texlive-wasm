import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
    watch: { ignored: ['**/engine/**', '**/vendor/**', '**/rust/target/**', '**/.git/**'] },
  },
});
