import { describe, expect, it } from 'vitest';
import { fakeCompactionSummary } from '../../e2e/fake-llm-compaction.js';

describe('fake compaction summary', () => {
  it('returns summary text instead of echoing the pinned Kilo v2 summarization instruction', () => {
    const summary = fakeCompactionSummary(
      'You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.\nSummarize only what the user and the assistant said and did.'
    );
    expect(summary).toContain('## Objective');
    expect(summary).toContain('## Next Move');
    expect(summary).toContain('This is a deterministic local test summary.');
    expect(summary).not.toContain('You MUST summarize');
  });

  it('also summarizes a later compaction that updates an existing checkpoint', () => {
    expect(
      fakeCompactionSummary(
        'Update the existing checkpoint in the conversation above into one consolidated summary.\nNewer history always takes precedence over the existing checkpoint.'
      )
    ).toContain('This is a deterministic local test summary.');
  });

  it.each(['Hello', 'Please summarize this conversation', '__fake__:echo:hello'])(
    'keeps ordinary prompt handling unchanged: %s',
    prompt => expect(fakeCompactionSummary(prompt)).toBeUndefined()
  );
});
