await Bun.build({
  entrypoints: ['./src/main.ts'],
  outdir: './dist',
  naming: 'wrapper.js',
  target: 'bun',
  minify: true,
  sourcemap: 'external',
});

console.log('Build complete: dist/wrapper.js');
