import { describe, expect, it, vi } from 'vitest';

// `client.js` statically imports `auth.js`, which imports `@kilocode/db`. This
// test only exercises pure helpers, so stubbing the two exporters keeps
// `@kilocode/db` out of the module graph.
vi.mock('../../e2e/auth.js', () => ({
  mintApiToken: vi.fn(() => 'minted-token'),
  mintStreamTicket: vi.fn(() => 'minted-ticket'),
}));

import {
  baselineSampleDelayMs,
  buildLongConversationFileTurns,
  classifyAllocationSample,
  LONG_CONVERSATION_HOT_TURNS,
  pollSampleDelayMs,
} from '../../e2e/scenarios-shared-conversations.js';
import { echoDirectivePayload } from '../../e2e/scenarios-shared.js';
import { assertReaderCannotDeriveNonce } from '../../e2e/scenario-assertions.js';
import { parseFileDirective } from '../../e2e/fake-llm-core.js';

describe('leave-and-return sampling schedule', () => {
  it('yields a baseline at +60 s after a 20 s allocation read and no catch-up burst', () => {
    const origin = 0;
    const readCompletedAt = 20_000;
    const baselineDelay = baselineSampleDelayMs(origin, 60_000, readCompletedAt);
    expect(baselineDelay).toBe(40_000);

    const baselineAt = readCompletedAt + baselineDelay;
    expect(baselineAt).toBe(60_000);

    // The next poll is anchored to the baseline completion, so it is a full
    // interval later rather than a catch-up sample at the original grid.
    expect(pollSampleDelayMs(baselineAt, 15_000, baselineAt)).toBe(15_000);
  });

  it('targets the baseline at the absolute origin+delay and clamps past due to zero', () => {
    expect(baselineSampleDelayMs(0, 60_000, 0)).toBe(60_000);
    expect(baselineSampleDelayMs(0, 60_000, 59_500)).toBe(500);
    expect(baselineSampleDelayMs(0, 60_000, 75_000)).toBe(0);
  });

  it('anchors each poll to the previous sample completion instead of a fixed grid', () => {
    expect(pollSampleDelayMs(80_000, 15_000, 80_500)).toBe(14_500);
    expect(pollSampleDelayMs(80_000, 15_000, 200_000)).toBe(0);
  });
});

describe('classifyAllocationSample', () => {
  it('reports absent when the surface observed no reference', () => {
    expect(classifyAllocationSample('ref_1', null)).toBe('absent');
  });

  it('reports retained when the baseline reference is unchanged', () => {
    expect(classifyAllocationSample('ref_1', 'ref_1')).toBe('retained');
  });

  it('reports replaced when a different reference is observed', () => {
    expect(classifyAllocationSample('ref_1', 'ref_2')).toBe('replaced');
  });
});

describe('buildLongConversationFileTurns', () => {
  it('writes an independent nonce the reader path/tag cannot derive', () => {
    const turns = buildLongConversationFileTurns('run1234');

    const write = parseFileDirective(turns.writeDirective.slice('file:'.length));
    expect(write.ok).toBe(true);
    if (!write.ok || write.directive.op !== 'write') throw new Error('expected a write directive');
    expect(write.directive.path).toBe(turns.filePath);

    const read = parseFileDirective(turns.readDirective.slice('file:'.length));
    expect(read.ok).toBe(true);
    if (!read.ok || read.directive.op !== 'read') throw new Error('expected a read directive');
    expect(read.directive.path).toBe(turns.filePath);

    // The actual generated write body must pass the private-nonce check.
    assertReaderCannotDeriveNonce({
      body: write.directive.contents,
      expectedNonce: turns.writerNonce,
      readerVisible: turns.readerDerivedBody,
      label: 'long-conversation file read',
    });
    expect(turns.writerNonce).not.toBe(turns.readerDerivedBody);
  });

  it('rejects the reader-derivable body the pre-fix code expected', () => {
    const turns = buildLongConversationFileTurns('run1234');
    expect(() =>
      assertReaderCannotDeriveNonce({
        body: turns.readerDerivedBody,
        expectedNonce: turns.writerNonce,
        readerVisible: turns.readerDerivedBody,
        label: 'regressed writer',
      })
    ).toThrow(/reader-derived value/);
  });
});

describe('LONG_CONVERSATION_HOT_TURNS', () => {
  it('holds ten directives with unique echo payloads and exactly one non-echo', () => {
    expect(LONG_CONVERSATION_HOT_TURNS).toHaveLength(10);

    const payloads = LONG_CONVERSATION_HOT_TURNS.map(echoDirectivePayload).filter(
      (payload): payload is string => payload !== null
    );
    expect(payloads).toHaveLength(9);
    expect(new Set(payloads).size).toBe(payloads.length);

    const nonEcho = LONG_CONVERSATION_HOT_TURNS.filter(
      directive => echoDirectivePayload(directive) === null
    );
    expect(nonEcho).toHaveLength(1);
  });

  it('holds only echo:<token> and slow:<n>:<ms>[-shaped] directives', () => {
    for (const directive of LONG_CONVERSATION_HOT_TURNS) {
      expect(directive).toMatch(/^(echo:[A-Za-z0-9_-]+|slow:\d+:\d+(:\d+)?)$/);
    }
  });
});
