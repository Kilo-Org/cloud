// Runs before any other module is loaded so we can influence module-level side
// effects (notably dotenv's tip banner). Imported as the very first statement
// in dev/seed/index.ts.

if (process.argv.includes('--json')) {
  // dotenv@17 reads DOTENV_CONFIG_QUIET to suppress its tip banner. We set it
  // here so that `apps/web/src/lib/load-env` (loaded transitively from
  // `./lib/db`) stays silent in machine-readable mode.
  process.env.DOTENV_CONFIG_QUIET = 'true';
}
