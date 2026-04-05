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

console.log('Build complete: dist/wrapper.js, dist/restore-session.js');
