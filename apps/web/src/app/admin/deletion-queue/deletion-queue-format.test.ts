import { parseDeletionEntries, parseDeletionQueueTab } from './deletion-queue-format';

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

describe('parseDeletionQueueTab', () => {
  it('accepts the remaining tabs and falls back unknown values to open', () => {
    expect(parseDeletionQueueTab('open')).toBe('open');
    expect(parseDeletionQueueTab('needs_attention')).toBe('needs_attention');
    expect(parseDeletionQueueTab('paused')).toBe('open');
    expect(parseDeletionQueueTab('manual_action')).toBe('needs_attention');
  });
});
