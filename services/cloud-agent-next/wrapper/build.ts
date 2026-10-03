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

await Bun.build({
  entrypoints: ['./src/github-review-publish-mcp.ts'],
  outdir: './dist',
  naming: 'github-review-publish-mcp',
  target: 'bun',
  minify: true,
});

await Bun.build({
  entrypoints: ['./src/control-plane/main.ts'],
  outdir: './dist',
  naming: 'control-plane-wrapper.js',
  target: 'bun',
  minify: true,
});

await chmod('./dist/bb', 0o755);
await chmod('./dist/github-review-publish-mcp', 0o755);

console.log(
  'Build complete: dist/wrapper.js, dist/restore-session.js, dist/bb, dist/github-review-publish-mcp, dist/control-plane-wrapper.js'
);
