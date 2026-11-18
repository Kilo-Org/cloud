/** @type {import('dependency-cruiser').IConfiguration} */
// The CI cycle gate for the web app: only circular dependencies are judged, so
// the check fails on a cycle and nothing else. `.dependency-cruiser.js` carries
// the wider rules for interactive use.
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A circular dependency must be broken with an inversion.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
