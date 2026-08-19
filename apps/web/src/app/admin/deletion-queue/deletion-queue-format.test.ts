import {
  deletionStepCountLabel,
  deletionStepProgressLabel,
  formatActivityDetail,
  parseDeletionEntries,
  parseDeletionQueueTab,
} from './deletion-queue-format';

describe('parseDeletionEntries', () => {
  it('parses one email per line', () => {
    expect(parseDeletionEntries('user1@example.com\nuser2@example.com')).toEqual([
      { email: 'user1@example.com' },
      { email: 'user2@example.com' },
    ]);
  });

  it('parses email and ticket on the same line', () => {
    expect(parseDeletionEntries('customer@test.com 1001\n jane@company.com #2002')).toEqual([
      { email: 'customer@test.com', pylonTicket: '1001' },
      { email: 'jane@company.com', pylonTicket: '2002' },
    ]);
  });

  it('parses a Pylon issue URL next to an email', () => {
    expect(parseDeletionEntries('jane@company.com https://app.usepylon.com/issues/2002')).toEqual([
      { email: 'jane@company.com', pylonTicket: '2002' },
    ]);
  });

  it('splits comma-separated emails into separate requests', () => {
    expect(parseDeletionEntries('user1@example.com, user2@example.com')).toEqual([
      { email: 'user1@example.com' },
      { email: 'user2@example.com' },
    ]);
  });

  it('parses ticket-only lines', () => {
    expect(parseDeletionEntries('#9999\nhttps://app.usepylon.com/issues/5678')).toEqual([
      { email: '', pylonTicket: '9999' },
      { email: '', pylonTicket: '5678' },
    ]);
  });

  it('skips a segment that contains two emails', () => {
    expect(parseDeletionEntries('first@example.com second@example.com #1234')).toEqual([]);
  });

  it('keeps leftover junk next to a ticket as a malformed email candidate', () => {
    expect(parseDeletionEntries('not-an-email #1234')).toEqual([
      { email: 'not-an-email', pylonTicket: '1234' },
    ]);
  });

  it('keeps a junk-only line as a malformed email candidate', () => {
    expect(parseDeletionEntries('not-an-email')).toEqual([{ email: 'not-an-email' }]);
  });
});

describe('deletionStepCountLabel', () => {
  it('uses a step-specific verb for known cleanup tasks', () => {
    expect(deletionStepCountLabel('cli_v2_sessions', 12)).toBe('12 deleted');
    expect(deletionStepCountLabel('usage_prompt_prefixes', 340)).toBe('340 scrubbed');
    expect(deletionStepCountLabel('kiloclaw_destroy', 2)).toBe('2 destroyed');
    expect(deletionStepCountLabel('customerio', 1)).toBe('1 removed');
  });
});

describe('deletionStepProgressLabel', () => {
  it('shows scanned usage rows even when nothing was scrubbed', () => {
    expect(deletionStepProgressLabel('usage_prompt_prefixes', 80, 49000)).toBe(
      '80 scrubbed · 49000 scanned'
    );
    expect(deletionStepProgressLabel('usage_prompt_prefixes', 0, 1000)).toBe('1000 scanned');
    expect(deletionStepProgressLabel('cli_v2_sessions', 0, 0)).toBeNull();
  });
});

describe('formatActivityDetail', () => {
  it('shows the step and how many records were processed', () => {
    expect(
      formatActivityDetail({
        stepKey: 'cli_v1_blobs',
        details: { processedCount: 3, errorCode: null },
      })
    ).toBe('CLI v1 · 3 deleted');
  });

  it('includes zero counts so empty work is visible', () => {
    expect(
      formatActivityDetail({
        stepKey: 'cli_v2_sessions',
        details: { processedCount: 0, errorCode: null },
      })
    ).toBe('CLI sessions · 0 deleted');
  });

  it('keeps error codes next to the count', () => {
    expect(
      formatActivityDetail({
        stepKey: 'usage_prompt_prefixes',
        details: { processedCount: 40, errorCode: 'usage_prefix_page_timeout' },
      })
    ).toBe('Usage prompts · 40 scrubbed · usage_prefix_page_timeout');
  });

  it('shows scanned usage rows next to scrubbed prefixes', () => {
    expect(
      formatActivityDetail({
        stepKey: 'usage_prompt_prefixes',
        details: { processedCount: 80, scannedCount: 49000, errorCode: null },
      })
    ).toBe('Usage prompts · 80 scrubbed · 49000 scanned');
  });
});

describe('parseDeletionQueueTab', () => {
  it('accepts the remaining tabs and falls back unknown values to open', () => {
    expect(parseDeletionQueueTab('open')).toBe('open');
    expect(parseDeletionQueueTab('needs_attention')).toBe('needs_attention');
    expect(parseDeletionQueueTab('paused')).toBe('open');
    expect(parseDeletionQueueTab('manual_action')).toBe('needs_attention');
  });
});
