import { describe, expect, it, vi } from 'vitest';

// `client.js` statically imports `auth.js`, which imports `@kilocode/db`. This
// test only exercises pure helpers, so stubbing the two exporters keeps
// `@kilocode/db` out of the module graph.
vi.mock('../../e2e/auth.js', () => ({
  mintApiToken: vi.fn(() => 'minted-token'),
  mintStreamTicket: vi.fn(() => 'minted-ticket'),
}));

import { buildLargeStreamSeedTurns } from '../../e2e/scenarios-shared-load.js';
import { assertReaderCannotDeriveNonce } from '../../e2e/scenario-assertions.js';
import { buildSeedFixture, parseFileDirective } from '../../e2e/fake-llm-core.js';

describe('buildLargeStreamSeedTurns', () => {
  it('writes an independent seed nonce the reader path/tag cannot derive', () => {
    const turns = buildLargeStreamSeedTurns('run1234');

    const seed = parseFileDirective(turns.seedDirective.slice('file:'.length));
    expect(seed.ok).toBe(true);
    if (!seed.ok || seed.directive.op !== 'seed') throw new Error('expected a seed directive');
    expect(seed.directive.path).toBe(turns.seedPath);
    expect(seed.directive.nonce).toBe(turns.seedNonce);

    const read = parseFileDirective(turns.readDirective.slice('file:'.length));
    expect(read.ok).toBe(true);
    if (!read.ok || read.directive.op !== 'read') throw new Error('expected a read directive');
    expect(read.directive.path).toBe(turns.seedPath);

    // The actual generated directive drives the actual fixture builder; the
    // first line is the nonce the read echo exposes.
    const fixture = buildSeedFixture(seed.directive.bytes, seed.directive.nonce);
    assertReaderCannotDeriveNonce({
      body: fixture.split('\n')[0] ?? null,
      expectedNonce: turns.seedNonce,
      readerVisible: turns.readerDerivedBody,
      label: 'large-stream seed read',
    });
    expect(turns.seedNonce).not.toBe(turns.readerDerivedBody);
  });

  it('rejects the reader-derivable nonce the pre-fix code expected', () => {
    const turns = buildLargeStreamSeedTurns('run1234');
    expect(() =>
      assertReaderCannotDeriveNonce({
        body: turns.readerDerivedBody,
        expectedNonce: turns.seedNonce,
        readerVisible: turns.readerDerivedBody,
        label: 'regressed seed',
      })
    ).toThrow(/reader-derived value/);
  });
});
