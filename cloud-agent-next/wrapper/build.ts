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
  entrypoints: ['./src/supervisor.ts'],
  outdir: './dist',
  naming: 'supervisor-wrapper.js',
  target: 'bun',
  minify: true,
  sourcemap: 'external',
});

console.log('Build complete: dist/wrapper.js, dist/restore-session.js, dist/supervisor-wrapper.js');
