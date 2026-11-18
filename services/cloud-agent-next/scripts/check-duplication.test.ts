import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compare,
  parseAllowlist,
  prune,
  runCli,
  scan,
  scanner,
  type DuplicationException,
  type Finding,
} from './check-duplication.js';

const copiedSource = `export function summarize(input: readonly number[]) {
  const positive = input.filter(value => Number.isFinite(value) && value > 0);
  const negative = input.filter(value => Number.isFinite(value) && value < 0);
  const total = positive.reduce((sum, value) => sum + value, 0);
  const sorted = positive.toSorted((left, right) => left - right);
  const first = sorted.at(0) ?? 0;
  const last = sorted.at(-1) ?? 0;
  const average = positive.length ? total / positive.length : 0;
  const result = {
    count: input.length,
    positive: positive.length,
    negative: negative.length,
    total,
    first,
    last,
    average,
    range: last - first,
    valid: input.every(value => Number.isFinite(value)),
  };
  return Object.freeze(result);
}
`;
const extendedCopiedSource = copiedSource.replace(
  '  return Object.freeze(result);',
  `  const doubled = sorted.map(value => value * 2);
  const bounded = doubled.filter(value => value < 1000);
  const boundedTotal = bounded.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    ...result,
    doubled,
    bounded,
    boundedTotal,
  });`
);
// Distinct surrounding token shapes keep weak-mode clone boundaries on copiedSource.
const twoBoundedCopies = `type BeforeOne = readonly [number, ...string[]];
${copiedSource}
if (true) { throw new Error('after-one'); }

class BeforeTwo extends Map<string, number> {}
${copiedSource}
for (const item of new Set([1, 2])) { console.info(item); }
`;
const thirdBoundedCopy = `const beforeThree = Symbol.for('three')
${copiedSource}
switch (Date.now()) { case 0: break; default: debugger; }
`;
const first = 'src/first.ts';
const second = 'wrapper/src/second.tsx';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-agent-duplication-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function allowance(finding: Finding): DuplicationException {
  return {
    files: finding.files,
    fingerprint: finding.fingerprint,
    owner: 'checker-tests',
    reason: 'The deliberate fixture copy verifies bounded scanner debt.',
    kind: 'intentional',
    maxMatches: finding.matches,
    maxTokens: finding.tokens,
  };
}

function firstFinding(findings: readonly Finding[]): Finding {
  const finding = findings[0];
  if (!finding) throw new Error('Expected the real scanner to find the copied fixture');
  return finding;
}

async function writeAllowlist(
  allowlistPath: string,
  exceptions: readonly unknown[]
): Promise<void> {
  await mkdir(dirname(allowlistPath), { recursive: true });
  await writeFile(
    allowlistPath,
    `${JSON.stringify({ version: 1, scanner, exceptions }, null, 2)}\n`
  );
}

async function editJson(
  file: string,
  edit: (value: Record<string, unknown>) => void
): Promise<void> {
  const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  edit(value);
  await writeFile(file, JSON.stringify(value));
}

const timeout = 90_000;

describe('real jscpd ratchet', () => {
  it(
    'detects cross-file copies, preserves line-shift identity, and rejects a third copy',
    async () => {
      await fixture({ [first]: copiedSource, [second]: copiedSource }, async root => {
        const initial = await scan(root);
        expect(initial.pairs).toBe(1);
        expect(initial.findings[0]?.files).toEqual([first, second]);
        const exceptions = initial.findings.map(allowance);
        expect(compare(initial.findings, [])).toContainEqual(
          expect.stringContaining('Unclassified')
        );
        expect(compare(initial.findings, exceptions)).toEqual([]);

        await writeFile(
          join(root, first),
          `\n\n// shifted without changing the clone\n${copiedSource}`
        );
        const shifted = await scan(root);
        expect(shifted.findings[0]?.fingerprint).toBe(initial.findings[0]?.fingerprint);
        expect(compare(shifted.findings, exceptions)).toEqual([]);

        await writeFile(join(root, 'src/third.ts'), copiedSource);
        const thirdCopy = await scan(root);
        expect(thirdCopy.pairs).toBeGreaterThan(shifted.pairs);
        expect(thirdCopy.findings.some(finding => finding.files.includes('src/third.ts'))).toBe(
          true
        );
        expect(compare(thirdCopy.findings, exceptions)).toContainEqual(
          expect.stringContaining('Unclassified duplication')
        );
        expect(compare(thirdCopy.findings, prune(thirdCopy.findings, exceptions))).toContainEqual(
          expect.stringContaining('Unclassified duplication')
        );
      });
    },
    timeout
  );

  it(
    'uses a rescanned source mutation and saved exception to enforce match bounds',
    async () => {
      await fixture({ [first]: twoBoundedCopies }, async root => {
        const allowlistPath = join(root, 'scripts/duplication-allowlist.json');
        const initialFinding = firstFinding((await scan(root)).findings);
        expect(initialFinding.matches).toBe(1);
        await writeAllowlist(allowlistPath, [allowance(initialFinding)]);
        const before = await readFile(allowlistPath, 'utf8');

        await writeFile(join(root, first), `${twoBoundedCopies}\n${thirdBoundedCopy}`);
        const rescannedFinding = (await scan(root)).findings.find(
          finding =>
            finding.fingerprint === initialFinding.fingerprint &&
            finding.files.join('\0') === initialFinding.files.join('\0')
        );
        expect(rescannedFinding?.matches).toBe(2);

        await expect(runCli([], { root, allowlistPath })).rejects.toThrow('Duplication grew');
        expect(await readFile(allowlistPath, 'utf8')).toBe(before);
        await expect(runCli(['--prune'], { root, allowlistPath })).rejects.toThrow(
          'Duplication grew'
        );
        expect(await readFile(allowlistPath, 'utf8')).toBe(before);
      });
    },
    timeout
  );

  it(
    'uses a rescanned source mutation and saved exceptions to enforce token bounds',
    async () => {
      await fixture({ [first]: copiedSource, [second]: copiedSource }, async root => {
        const allowlistPath = join(root, 'scripts/duplication-allowlist.json');
        const initialFinding = firstFinding((await scan(root)).findings);
        const initialException = allowance(initialFinding);
        await writeAllowlist(allowlistPath, [initialException]);

        await writeFile(join(root, first), extendedCopiedSource);
        await writeFile(join(root, second), extendedCopiedSource);
        const tokenFinding = firstFinding((await scan(root)).findings);
        expect(tokenFinding.tokens).toBeGreaterThan(initialFinding.tokens);
        const boundedExpandedException = {
          ...allowance(tokenFinding),
          maxTokens: initialFinding.tokens,
        };
        await writeAllowlist(allowlistPath, [initialException, boundedExpandedException]);
        const before = await readFile(allowlistPath, 'utf8');

        await expect(runCli([], { root, allowlistPath })).rejects.toThrow('Duplication grew');
        await expect(runCli(['--prune'], { root, allowlistPath })).rejects.toThrow(
          'Duplication grew'
        );
        expect(await readFile(allowlistPath, 'utf8')).toBe(before);
      });
    },
    timeout
  );

  it(
    'detects a same-file clone',
    async () => {
      await fixture(
        { [first]: `${copiedSource}\n${copiedSource.replace('summarize', 'describe')}` },
        async root => {
          const result = await scan(root);
          expect(result.pairs).toBeGreaterThan(0);
          expect(
            result.findings.some(
              finding => finding.files[0] === first && finding.files[1] === first
            )
          ).toBe(true);
        }
      );
    },
    timeout
  );

  it(
    'fails closed for empty scope, inline suppression, scanner failure, and report failures',
    async () => {
      await fixture({}, async root => {
        await expect(scan(root)).rejects.toThrow('No production source files');
      });
      await fixture({ [first]: `/* jscpd:ignore-start */\n${copiedSource}` }, async root => {
        await expect(scan(root)).rejects.toThrow('Inline duplication suppression is not allowed');
      });
      await fixture({ [first]: copiedSource }, async root => {
        await expect(
          scan(root, { scannerCommand: [process.execPath, '-e', 'process.exit(7)', '--'] })
        ).rejects.toThrow('Duplication scanner failed (7)');
        await expect(scan(root, { scannerCommand: ['/missing/jscpd'] })).rejects.toThrow(
          'Duplication scanner failed to start'
        );
        await expect(
          scan(root, {
            afterScanner: output => rm(join(output, 'jscpd-report.json')),
          })
        ).rejects.toThrow('jscpd JSON report is missing');
        await expect(
          scan(root, {
            afterScanner: output => writeFile(join(output, 'jscpd-report.json'), '{'),
          })
        ).rejects.toThrow('jscpd JSON report is malformed');
        await expect(
          scan(root, {
            afterScanner: output =>
              editJson(join(output, 'jscpd-report.sarif'), value => {
                const runs = value.runs as Array<Record<string, unknown>>;
                const tool = runs[0]?.tool as Record<string, unknown>;
                const driver = tool.driver as Record<string, unknown>;
                driver.version = '0.0.0';
              }),
          })
        ).rejects.toThrow('Unexpected duplication scanner version');
        await expect(
          scan(root, {
            afterScanner: output =>
              editJson(join(output, 'jscpd-report.json'), value => {
                const statistics = value.statistics as Record<string, unknown>;
                const total = statistics.total as Record<string, unknown>;
                total.clones = 1;
              }),
          })
        ).rejects.toThrow('Duplication reports disagree');
      });
    },
    timeout
  );

  it(
    'CLI check/report reject malformed or stale debt and prune only removes or lowers it',
    async () => {
      await fixture({ [first]: copiedSource, [second]: copiedSource }, async root => {
        const allowlistPath = join(root, 'scripts/duplication-allowlist.json');
        const initial = await scan(root);
        const exceptions = initial.findings.map(allowance);
        await writeAllowlist(allowlistPath, exceptions);
        const before = await readFile(allowlistPath, 'utf8');
        const output: string[] = [];
        await runCli([], { root, allowlistPath, output: value => output.push(value) });
        await runCli(['--', '--report'], {
          root,
          allowlistPath,
          output: value => output.push(value),
        });
        expect(await readFile(allowlistPath, 'utf8')).toBe(before);
        expect(output.join('\n')).toContain('bounded exceptions; no new duplication');
        expect(output.join('\n')).toContain('"findings"');

        await writeFile(allowlistPath, '{');
        await expect(runCli([], { root, allowlistPath })).rejects.toThrow(
          'duplication allowlist is malformed'
        );

        const exception = exceptions[0];
        if (!exception) throw new Error('Expected the real scanner exception');
        const malformed = [{ ...exception, extra: true }];
        await writeAllowlist(allowlistPath, malformed);
        const malformedBefore = await readFile(allowlistPath, 'utf8');
        await expect(runCli([], { root, allowlistPath })).rejects.toThrow(
          'Malformed duplication exception'
        );
        await expect(runCli(['--prune'], { root, allowlistPath })).rejects.toThrow(
          'Malformed duplication exception'
        );
        expect(await readFile(allowlistPath, 'utf8')).toBe(malformedBefore);

        await writeAllowlist(allowlistPath, [exception, exception]);
        const duplicateBefore = await readFile(allowlistPath, 'utf8');
        await expect(runCli([], { root, allowlistPath })).rejects.toThrow('Duplicate exception');
        await expect(runCli(['--prune'], { root, allowlistPath })).rejects.toThrow(
          'Duplicate exception'
        );
        expect(await readFile(allowlistPath, 'utf8')).toBe(duplicateBefore);

        const oversized = exceptions.map(entry => ({
          ...entry,
          maxMatches: entry.maxMatches + 1,
          maxTokens: entry.maxTokens + 1,
        }));
        await writeAllowlist(allowlistPath, oversized);
        await runCli(['--prune'], { root, allowlistPath, output: () => undefined });
        expect(parseAllowlist(JSON.parse(await readFile(allowlistPath, 'utf8')))).toEqual(
          exceptions
        );
        const pruned = await readFile(allowlistPath, 'utf8');

        await writeFile(join(root, 'src/third.ts'), copiedSource);
        await expect(runCli(['--prune'], { root, allowlistPath })).rejects.toThrow(
          'Unclassified duplication'
        );
        expect(await readFile(allowlistPath, 'utf8')).toBe(pruned);

        await rm(join(root, second));
        await rm(join(root, 'src/third.ts'));
        await expect(runCli([], { root, allowlistPath })).rejects.toThrow('Stale exception');
        await runCli(['--prune'], { root, allowlistPath, output: () => undefined });
        expect(parseAllowlist(JSON.parse(await readFile(allowlistPath, 'utf8')))).toEqual([]);
      });
    },
    timeout
  );
});

describe('allowlist validation', () => {
  const entry: DuplicationException = {
    files: [first, second],
    fingerprint: '0123456789abcdef',
    owner: 'checker-tests',
    reason: 'Reviewed protocol compatibility copy.',
    kind: 'intentional',
    maxMatches: 1,
    maxTokens: 100,
  };
  const data = { version: 1, scanner, exceptions: [entry] };

  it('rejects stale, malformed, duplicate, unsorted, and scanner-mismatched exceptions', () => {
    expect(parseAllowlist(data)).toEqual([entry]);
    expect(compare([], [entry])).toContainEqual(expect.stringContaining('Stale exception'));
    for (const change of [
      { owner: '' },
      { reason: ' ' },
      { fingerprint: 'bad' },
      { kind: 'ignore' },
      { maxMatches: 0 },
      { maxTokens: 0 },
      { files: [second, first] },
      { files: [first] },
      { files: ['../outside.ts', second] },
      { extra: true },
    ]) {
      expect(() => parseAllowlist({ ...data, exceptions: [{ ...entry, ...change }] })).toThrow();
    }
    expect(() => parseAllowlist({ ...data, exceptions: [entry, entry] })).toThrow(
      'Duplicate exception'
    );
    expect(() => parseAllowlist({ ...data, scanner: 'jscpd@latest' })).toThrow('Unsupported');
    expect(() => parseAllowlist({ ...data, extra: true })).toThrow(
      'Malformed duplication allowlist'
    );
  });
});
