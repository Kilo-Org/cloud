/**
 * Runs every live check, in order, and reports what held.
 *
 * These runs cost real money and real time, so they are not part of
 * `pnpm check` and never will be. This exists because a change to the wire or
 * to the session has to be answered by the provider, not by a fake, and
 * running seventeen commands by hand invites running sixteen.
 *
 * `pnpm test:e2e:all`. One failure does not stop the rest: the point of a
 * sweep is to learn everything that broke, not the first thing. Name runs to
 * pick a few: `pnpm test:e2e:all stop reasoning`.
 *
 * Every run works through one model. `pnpm test:e2e:all full` works through all
 * eleven, which is eleven times the bill and is asked for by hand.
 */
import { spawn } from 'node:child_process';

/** Ordered cheapest first, so a broken transport is reported in seconds. */
const runs = [
  'live',
  'shapes',
  'stop',
  'tools',
  'image',
  'cancel',
  'queue',
  'together',
  'subagent',
  'session',
  'resume',
  'clone',
  'reasoning',
  'replay',
  'compact',
  'models',
  'tool-matrix',
] as const;

const argv = process.argv.slice(2);

/* Every run reads its own command line, and never sees this one, so the word
   travels to the children as an environment variable. */
const full = argv.includes('full');
const only = argv.filter(name => name !== 'full');

/* A name nobody runs is a name nobody meant. Reporting "0 of 0 passed" and
   exiting 0 on a typo is the worst answer a sweep can give. */
const known: ReadonlySet<string> = new Set(runs);
const unknown = only.filter(name => !known.has(name));
if (unknown.length > 0) {
  console.log(`no such live run: ${unknown.join(', ')}\nthere is: ${runs.join(', ')}`);
  process.exit(1);
}
const chosen = only.length === 0 ? runs : runs.filter(name => only.includes(name));

/** The cache run is the default one, so its script has no suffix. */
const scriptOf = (name: string): string => (name === 'live' ? 'test:e2e' : `test:e2e:${name}`);

const runOne = (name: string): Promise<{ ok: boolean; taken: number; tail: string }> =>
  new Promise(resolve => {
    const started = Date.now();
    const held: string[] = [];
    const child = spawn('pnpm', [scriptOf(name)], {
      cwd: `${import.meta.dirname}/..`,
      env: full ? { ...process.env, KILO_FULL: '1' } : process.env,
    });
    const keep = (chunk: Buffer): void => {
      held.push(chunk.toString());
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', code => {
      const lines = held.join('').trimEnd().split('\n');
      resolve({
        ok: code === 0,
        taken: Date.now() - started,
        tail: lines.slice(-1)[0] ?? '',
      });
    });
  });

const failed: string[] = [];

for (const name of chosen) {
  const { ok, taken, tail } = await runOne(name);
  const seconds = `${(taken / 1000).toFixed(0)}s`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)}${seconds.padStart(5)}  ${tail}`);
  if (!ok) {
    failed.push(name);
  }
}

console.log(
  `\n${String(chosen.length - failed.length)} of ${String(chosen.length)} live runs passed.`
);
if (failed.length > 0) {
  console.log(`re-run one on its own for the whole output: pnpm ${scriptOf(failed[0] ?? '')}`);
  process.exitCode = 1;
}
