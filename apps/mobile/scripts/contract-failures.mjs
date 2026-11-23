// The failure accumulator every contract script in this directory reports through.
//
// Two scripts here evaluate a build contract before the bundler or the store
// does: `assert-expo-config.mjs` reads the evaluated Expo config, and
// `assert-react-native-resolution.mjs` reads the module Metro resolves. Each
// states many independent requirements, so each collects its failures instead of
// stopping at the first. One shared helper keeps that collection in one shape:
// `check(condition, message)` pushes `message` when `condition` is falsy, so a
// call copied between the scripts keeps its meaning, and `report(heading)`
// prints every failure as one `  - ` bullet and returns the process exit code.
//
// A message that spans several lines puts its detail on the indented lines below
// its summary line (as `assert-react-native-resolution.mjs` does with each
// resolved path), so both scripts still report one bullet per failed condition.
export function createContractFailures() {
  const failures = [];

  function check(condition, message) {
    if (!condition) failures.push(message);
  }

  /**
   * Prints the collected failures under `heading`, then the optional `hint` that
   * says how to fix them. Returns the process exit code: 0 when nothing failed.
   */
  function report(heading, hint) {
    if (failures.length === 0) return 0;
    console.error(`${heading} (${failures.length} failure${failures.length === 1 ? '' : 's'}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    if (hint !== undefined) console.error(`\n${hint}`);
    return 1;
  }

  return { check, report };
}
