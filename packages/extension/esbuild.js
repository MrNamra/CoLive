import * as esbuild from 'esbuild';

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/**
 * Lightweight logger shim for the extension bundle.
 * Pino is only used by the embedded @colive/server in TunnelManager.
 * Shimming pino eliminates sonic-boom, thread-stream, @pinojs/redact,
 * pino-std-serializers, and atomic-sleep (~60KB) without altering behavior.
 */
const pinoShimPlugin = {
  name: 'pino-shim',
  setup(build) {
    build.onResolve({ filter: /^pino$/ }, () => ({
      path: 'pino',
      namespace: 'pino-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'pino-shim' }, () => ({
      contents: `
        function noop() {}
        function createLogger() {
          const l = {
            info: (o, m) => { if (typeof m === 'string') console.log(m); else if (typeof o === 'string') console.log(o); },
            warn: (o, m) => { if (typeof m === 'string') console.warn(m); else if (typeof o === 'string') console.warn(o); },
            error: (o, m) => { if (typeof m === 'string') console.error(m); else if (typeof o === 'string') console.error(o); },
            debug: noop,
            trace: noop,
            fatal: (o, m) => { if (typeof m === 'string') console.error(m); else if (typeof o === 'string') console.error(o); },
            child: () => l,
            level: 'info',
          };
          return l;
        }
        module.exports = function pino() { return createLogger(); };
        module.exports.default = module.exports;
        module.exports.pino = module.exports;
      `,
      loader: 'js',
    }));
  },
};

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.cjs',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  define: {
    'import.meta.url': '""',
    'import.meta': '{}',
  },
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  legalComments: 'none',
  drop: isProduction ? ['debugger'] : [],
  plugins: [pinoShimPlugin],
  logLevel: 'info',
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.info('Watching packages/extension for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.info('Extension build complete.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
