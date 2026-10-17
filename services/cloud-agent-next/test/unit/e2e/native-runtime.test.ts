import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { assertDriverTarget } from '../../e2e/native-runtime.js';

import {
  NATIVE_FIXTURE_EXPECTED_ENV,
  NATIVE_FIXTURE_MODE_ENV,
  NATIVE_FIXTURE_SCRIPT,
  NATIVE_RUNTIME_MEASURE_SCRIPT,
  classifyNativeRun,
  classifyRuntimeTransition,
  extractStreamText,
  nativeFixtureEnv,
  nativeFixtureSetupCommands,
  nativeRuntimeMeasureCommands,
} from '../../e2e/native-runtime-support.js';

const tmpDirs: string[] = [];
it('requires an explicit HTTPS ingest origin before using a personal bearer', () => {
  const target = {
    workerUrl: 'https://cloud-agent-next-unit-test.engineering-e11.workers.dev',
    fakeLlmUrl: 'http://localhost:9511',
    authFile: '/not-read.json',
    webUrl: 'https://api.kilo.ai',
  };
  expect(() => assertDriverTarget({ ...target, ingestUrl: '' })).toThrow(/explicit HTTPS/);
  expect(() => assertDriverTarget({ ...target, ingestUrl: 'http://localhost:9500' })).toThrow(
    /bare HTTPS/
  );
  expect(() =>
    assertDriverTarget({ ...target, ingestUrl: 'https://ingest.example.test' })
  ).not.toThrow();
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-fixture-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runFixture(dir: string, mode: 'seed' | 'restore', expected: string): number {
  try {
    execFileSync('sh', ['-c', NATIVE_FIXTURE_SCRIPT], {
      cwd: dir,
      env: { ...process.env, ...nativeFixtureEnv(mode, expected) },
      stdio: 'pipe',
    });
    return 0;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: number }).status)
      : -1;
  }
}

describe('native fixture command', () => {
  it('stays within the 500-character budget and is stable across modes', () => {
    expect(NATIVE_FIXTURE_SCRIPT.length).toBeLessThanOrEqual(500);
    expect(NATIVE_RUNTIME_MEASURE_SCRIPT.length).toBeLessThanOrEqual(500);
    expect(nativeFixtureSetupCommands()).toEqual([
      NATIVE_FIXTURE_SCRIPT,
      NATIVE_RUNTIME_MEASURE_SCRIPT,
    ]);
    expect(nativeRuntimeMeasureCommands()).toEqual([NATIVE_RUNTIME_MEASURE_SCRIPT]);
    // The command array is mode-independent: only the nonsecret env varies.
    expect(nativeFixtureSetupCommands()).toEqual(nativeFixtureSetupCommands());
    const seed = nativeFixtureEnv('seed', 'expected-a');
    const restore = nativeFixtureEnv('restore', 'expected-a');
    expect(Object.keys(seed).every(name => !name.startsWith('KILO'))).toBe(true);
    expect(seed[NATIVE_FIXTURE_MODE_ENV]).toBe('seed');
    expect(restore[NATIVE_FIXTURE_MODE_ENV]).toBe('restore');
    expect(seed[NATIVE_FIXTURE_EXPECTED_ENV]).toBe(restore[NATIVE_FIXTURE_EXPECTED_ENV]);
  });

  it('fails a restore when the dependency is missing even though the sentinel is present', () => {
    const dir = workspace();
    expect(runFixture(dir, 'seed', 'expected-value')).toBe(0);
    rmSync(join(dir, 'node_modules', 'fx-dep', 'index.js'));
    expect(runFixture(dir, 'restore', 'expected-value')).toBe(9);
  });

  it('fails a restore when the imported dependency is wrong (regression: ignored bun exit)', () => {
    const dir = workspace();
    expect(runFixture(dir, 'seed', 'expected-value')).toBe(0);
    // Present but wrong: the `bun -e` import must fail the script, not fall
    // through to the trailing `exit 0`.
    writeFileSync(join(dir, 'node_modules', 'fx-dep', 'index.js'), 'exports.v=2;exports.x=()=>0;');
    expect(runFixture(dir, 'restore', 'expected-value')).toBe(8);
  });

  it('seeds the dependency and sentinel, then restores by reading and importing them', () => {
    const dir = workspace();
    expect(runFixture(dir, 'seed', 'expected-value')).toBe(0);
    expect(readFileSync(join(dir, '.fx', 'sentinel'), 'utf8')).toBe('expected-value');
    expect(existsSync(join(dir, 'node_modules', 'fx-dep', 'index.js'))).toBe(true);
    expect(runFixture(dir, 'restore', 'expected-value')).toBe(0);
  });

  it('fails a restore with a missing sentinel instead of recreating it', () => {
    const dir = workspace();
    // Exit code 9 is the missing-sentinel guard, before any import or write.
    expect(runFixture(dir, 'restore', 'expected-value')).toBe(9);
    expect(existsSync(join(dir, '.fx', 'sentinel'))).toBe(false);
    expect(existsSync(join(dir, 'node_modules', 'fx-dep', 'index.js'))).toBe(false);
  });

  it('fails a restore when the sentinel changed without touching the dependency', () => {
    const dir = workspace();
    expect(runFixture(dir, 'seed', 'expected-value')).toBe(0);
    expect(runFixture(dir, 'restore', 'different-value')).toBe(7);
  });
});

describe('native result classification', () => {
  it('reports unsupported when the session works but no native evidence exists', () => {
    const outcome = classifyNativeRun({
      coldTurnCompleted: true,
      coldToolTurnObserved: true,
      followupCompleted: true,
    });
    expect(outcome.functional).toBe('pass');
    expect(outcome.status).toBe('unsupported');
    expect(outcome.evidence).toEqual({
      snapshot: 'unverified',
      index: 'unverified',
      managedBase: 'unverified',
      containment: 'unverified',
    });
    expect(outcome.notes.join(' ')).toMatch(/snapshot evidence unavailable locally/);
  });

  it('passes only when every evidence source is explicitly verified', () => {
    const outcome = classifyNativeRun({
      coldTurnCompleted: true,
      coldToolTurnObserved: true,
      followupCompleted: true,
      evidence: {
        snapshot: 'verified',
        index: 'verified',
        managedBase: 'verified',
        containment: 'verified',
      },
    });
    expect(outcome.status).toBe('pass');
  });

  it('fails when the cold turn or followup did not complete', () => {
    expect(
      classifyNativeRun({
        coldTurnCompleted: false,
        coldToolTurnObserved: true,
        followupCompleted: true,
      }).status
    ).toBe('fail');
    expect(
      classifyNativeRun({
        coldTurnCompleted: true,
        coldToolTurnObserved: false,
        followupCompleted: true,
      }).functional
    ).toBe('fail');
    expect(
      classifyNativeRun({
        coldTurnCompleted: true,
        coldToolTurnObserved: true,
        followupCompleted: false,
      }).status
    ).toBe('fail');
  });

  it('reports a matching CLI upgrade as unsupported without snapshot evidence', () => {
    const outcome = classifyRuntimeTransition({
      mode: 'cli-upgrade',
      expectedCliSha256: 'a'.repeat(64),
      observedCliSha256: 'a'.repeat(64),
    });
    expect(outcome.functional).toBe('pass');
    expect(outcome.status).toBe('unsupported');
  });

  it('fails a wrapper-only run that refetches the CLI or misses the expected hashes', () => {
    const refetched = classifyRuntimeTransition({
      mode: 'wrapper-only',
      expectedCliSha256: 'a'.repeat(64),
      expectedControlSha256: 'b'.repeat(64),
      observedCliSha256: 'a'.repeat(64),
      observedControlSha256: 'b'.repeat(64),
      cliRefetched: true,
    });
    expect(refetched.functional).toBe('fail');
    expect(refetched.notes.join(' ')).toMatch(/refetched/);

    const mismatch = classifyRuntimeTransition({
      mode: 'wrapper-only',
      expectedCliSha256: 'a'.repeat(64),
      expectedControlSha256: 'b'.repeat(64),
      observedCliSha256: 'a'.repeat(64),
      observedControlSha256: 'c'.repeat(64),
    });
    expect(mismatch.functional).toBe('fail');
  });
});

describe('stream text extraction', () => {
  it('joins text and delta fields from stream events', () => {
    const text = extractStreamText([
      { streamEventType: 'cloud.text.delta', data: { delta: 'hello ' } },
      { streamEventType: 'cloud.text.delta', data: { text: 'world' } },
      { streamEventType: 'cloud.tool.completed', data: { tool: 'bash' } },
    ]);
    expect(text).toBe('hello world');
  });
});
