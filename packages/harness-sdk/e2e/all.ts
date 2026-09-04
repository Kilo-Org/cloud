/**
 * Runs every live check, in order, and reports what held.
 *
 * These runs cost real money and real time, so they are not part of
 * `pnpm check` and never will be. This exists because a change to the wire or
 * to the session has to be answered by the provider, not by a fake, and
 * running eight commands by hand invites running seven.
 *
 * `pnpm test:e2e:all`. One failure does not stop the rest: the point of a
 * sweep is to learn everything that broke, not the first thing.
 */
import { spawn } from 'node:child_process';

/** Ordered cheapest first, so a broken transport is reported in seconds. */
const runs = [
  'live',
  'shapes',
  'stop',
  'image',
  'cancel',
  'session',
  'reasoning',
  'compact',
  'models',
] as const;

const only = process.argv.slice(2);
const chosen = only.length === 0 ? runs : runs.filter(name => only.includes(name));

/** The cache run is the default one, so its script has no suffix. */
const scriptOf = (name: string): string => (name === 'live' ? 'test:e2e' : `test:e2e:${name}`);

const runOne = (name: string): Promise<{ ok: boolean; taken: number; tail: string }> =>
  new Promise(resolve => {
    const started = Date.now();
    const held: string[] = [];
    const child = spawn('pnpm', [scriptOf(name)], { cwd: `${import.meta.dirname}/..` });
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
