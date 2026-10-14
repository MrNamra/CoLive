import * as esbuild from 'esbuild';

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

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
  },
  sourcemap: !isProduction,
  minify: isProduction,
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
