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

/**
 * The model whatever fails next was working on.
 *
 * A run works through a list of models, and a report that says "the answer
 * carried no text" without saying whose is a report nobody can act on. Every
 * run calls `under` before each model, and the name is put on what it records.
 */
let scope = '';

/** Names the model the checks after this belong to. */
const under = (model: string): void => {
  scope = model;
};

/** Records one thing that is wrong, and carries on. */
const fail = (why: string): void => {
  failures.push(scope === '' ? why : `${scope}: ${why}`);
};

/** Records one thing that is wrong if it is wrong, and carries on either way. */
const wrongIf = (broken: boolean, why: string): void => {
  if (broken) {
    fail(why);
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

export { fail, failures, passed, under, wrongIf };
