import { runOfflineSweep } from '../src/scoreboard/offline-sweep';

runOfflineSweep(process.argv.slice(2))
  .then(({ sweep, out, mode }) => {
    if (mode === 'summarize') return;
    const saved = sweep.pairs.reduce((sum, pair) => sum + pair.results.length, 0);
    console.log(`Saved ${saved} case results to ${out}${sweep.truncated ? ' (truncated)' : ''}`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Offline sweep failed');
    process.exitCode = 1;
  });
