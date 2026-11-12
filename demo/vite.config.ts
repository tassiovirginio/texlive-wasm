import { defineConfig, type Plugin, type Connect } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const ENGINE_ARTIFACTS = resolve(__dirname, '../engine-artifacts');

/**
 * Serve `../engine-artifacts/*` at `/core/*` during `vite dev` and
 * `vite preview`. For production deploys the consumer is expected to host
 * the artifacts themselves.
 */
function serveEngineArtifacts(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    const requested = resolve(ENGINE_ARTIFACTS, '.' + urlPath);
    // Separator-anchored containment: "engine-artifacts-evil" must not pass.
    if (requested !== ENGINE_ARTIFACTS && !requested.startsWith(ENGINE_ARTIFACTS + sep)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }

    // Pre-compressed asset negotiation: if the client advertises br/gzip
    // and a sibling .br/.gz file exists, serve that with the appropriate
    // Content-Encoding header. Saves ~70% on .wasm transfer in the demo.
    const accept = (req.headers['accept-encoding'] as string | undefined) ?? '';
    const candidates = [
      accept.includes('br') ? { ext: '.br', enc: 'br' } : null,
      accept.includes('gzip') ? { ext: '.gz', enc: 'gzip' } : null,
    ].filter((x): x is { ext: string; enc: string } => x !== null);

    let filePath = requested;
    let encoding: string | null = null;
    for (const c of candidates) {
      const pre = requested + c.ext;
      if (existsSync(pre) && statSync(pre).isFile()) {
        filePath = pre;
        encoding = c.enc;
        break;
      }
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return next();
    }
    const base = filePath.replace(/\.(br|gz)$/, '');
    const contentType = base.endsWith('.js')
      ? 'application/javascript'
      : base.endsWith('.wasm')
        ? 'application/wasm'
        : base.endsWith('.tar.gz')
          ? 'application/gzip'
          : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (encoding) res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', String(statSync(filePath).size));
    createReadStream(filePath).pipe(res);
  };

  return {
    name: 'serve-engine-artifacts',
    configureServer(server) {
      server.middlewares.use('/core', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/core', handler);
    },
  };
}

export default defineConfig({
  // Relative base: the site deploys under https://<owner>.github.io/<repo>/
  // and this is a single-page hash-tab app, so './' works everywhere.
  base: './',
  plugins: [solid(), wasm(), serveEngineArtifacts()],
  clearScreen: false,
  // The engines are single-threaded wasm — no COOP/COEP isolation needed,
  // dev and production (plain GitHub Pages) behave identically.
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  optimizeDeps: {
    exclude: ['@typeward/texlive-wasm'],
  },
});
