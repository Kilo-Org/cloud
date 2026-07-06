import { chmod, rm } from 'node:fs/promises';

await rm('./dist/kilo-bitbucket-review', { force: true });

await Bun.build({
  entrypoints: ['./src/main.ts'],
  outdir: './dist',
  naming: 'wrapper.js',
  target: 'bun',
  minify: true,
  sourcemap: 'external',
});

await Bun.build({
  entrypoints: ['./src/restore-session.ts'],
  outdir: './dist',
  naming: 'restore-session.js',
  target: 'bun',
  minify: true,
});

await Bun.build({
  entrypoints: ['./src/bitbucket-review-cli.ts'],
  outdir: './dist',
  naming: 'bb',
  target: 'bun',
  minify: true,
});

await chmod('./dist/bb', 0o755);

console.log('Build complete: dist/wrapper.js, dist/restore-session.js, dist/bb');
