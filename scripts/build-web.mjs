import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const entries = ['admin', 'index', 'label'].filter((name) => existsSync(`src/web/${name}.ts`));

if (entries.length === 0) {
  console.error('build-web: no src/web entries found');
  process.exit(1);
}

await build({
  entryPoints: entries.map((name) => `src/web/${name}.ts`),
  outdir: 'public/js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
