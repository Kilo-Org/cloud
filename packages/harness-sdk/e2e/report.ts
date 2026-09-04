import assert from 'node:assert/strict';

/**
 * How every live run says what held and what did not.
 *
 * A run gathers what is wrong and says all of it at the end, rather than
 * throwing on the first thing. That is deliberate: these runs cost money and
 * minutes, and learning one failure per run turns an afternoon into a week.
 *
 * Fifteen runs wrote these lines each. The shared copy also settles the
 * wording, which matters more than it sounds: a reader comparing two failing
 * runs should not have to work out whether two differently-phrased reports mean
 * the same thing.
 */

/** What is wrong so far. Empty at the end is the run passing. */
const failures: string[] = [];

/** Records one thing that is wrong, and carries on. */
const wrongIf = (broken: boolean, why: string): void => {
  if (broken) {
    failures.push(why);
  }
};

/**
 * Ends the run: throws with everything that was wrong, or says what held.
 *
 * Give `what` in the past tense and without a full stop — it is printed after
 * "PASS: ", and it is the one line `e2e/all.ts` shows for a run that passed.
 */
const passed = (what: string): void => {
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
  console.log(`\nPASS: ${what}`);
};

export { failures, passed, wrongIf };
