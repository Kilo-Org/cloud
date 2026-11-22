import {
  createBoundedStatusLog,
  STATUS_LOG_MAX_ENTRIES,
  STATUS_LOG_MAX_LINE_LENGTH,
  STATUS_LOG_MAX_TOTAL_LENGTH,
} from './bounded-status-log';

function makeLine(index: number): string {
  return `line-${index}`;
}

function totalLength(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length, 0);
}

describe('createBoundedStatusLog', () => {
  it('drops the oldest entries once the entry cap is exceeded', () => {
    const log = createBoundedStatusLog();
    const overflow = 50;

    for (let i = 0; i < STATUS_LOG_MAX_ENTRIES + overflow; i++) {
      log.push(makeLine(i));
    }

    const entries = log.entries();
    expect(entries).toHaveLength(STATUS_LOG_MAX_ENTRIES);
    expect(entries[0]).toBe(makeLine(overflow));
    expect(entries[entries.length - 1]).toBe(makeLine(STATUS_LOG_MAX_ENTRIES + overflow - 1));
    expect(log.droppedCount()).toBe(overflow);
  });

  it('truncates an over-long line to exactly the line cap with a trailing marker', () => {
    const log = createBoundedStatusLog();
    const longLine = 'x'.repeat(STATUS_LOG_MAX_LINE_LENGTH * 2);

    log.push(longLine);

    const entries = log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveLength(STATUS_LOG_MAX_LINE_LENGTH);
    expect(entries[0]?.endsWith('…')).toBe(true);
    expect(log.droppedCount()).toBe(0);
  });

  it('does not cut between the halves of a surrogate pair', () => {
    const log = createBoundedStatusLog();
    // Emoji only, so the cap lands between the two halves of one pair: with a
    // plain slice the kept text ends on a high surrogate and cannot render.
    log.push('😀'.repeat(STATUS_LOG_MAX_LINE_LENGTH));

    const [stored] = log.entries();
    expect(stored).toBe('😀'.repeat(149) + '…');
  });

  it('drops oldest entries first when the total-length ceiling is exceeded', () => {
    const log = createBoundedStatusLog();
    const lineCount = 40;

    for (let i = 0; i < lineCount; i++) {
      log.push('y'.repeat(STATUS_LOG_MAX_LINE_LENGTH));
    }

    const entries = log.entries();
    expect(totalLength(entries)).toBeLessThanOrEqual(STATUS_LOG_MAX_TOTAL_LENGTH);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(lineCount);
    expect(log.droppedCount()).toBe(lineCount - entries.length);
  });

  it('skips empty and whitespace-only lines without counting them as dropped', () => {
    const log = createBoundedStatusLog();

    log.push('');
    log.push('   ');
    log.push('\n\t ');

    expect(log.entries()).toHaveLength(0);
    expect(log.droppedCount()).toBe(0);
  });

  it('always keeps the newest line when the total ceiling is exceeded', () => {
    const log = createBoundedStatusLog();
    const filler = 'z'.repeat(STATUS_LOG_MAX_LINE_LENGTH);
    const pushes = Math.floor(STATUS_LOG_MAX_TOTAL_LENGTH / STATUS_LOG_MAX_LINE_LENGTH);

    for (let i = 0; i < pushes; i++) {
      log.push(filler);
    }
    expect(totalLength(log.entries())).toBeLessThanOrEqual(STATUS_LOG_MAX_TOTAL_LENGTH);

    // The newest line must survive even though it cannot fit beside the kept ones.
    const newest = 'n'.repeat(STATUS_LOG_MAX_LINE_LENGTH);
    log.push(newest);

    const entries = log.entries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1]).toBe(newest);
    expect(totalLength(entries)).toBeLessThanOrEqual(STATUS_LOG_MAX_TOTAL_LENGTH);
    expect(log.droppedCount()).toBeGreaterThan(0);
  });

  it('preserves insertion order, oldest first', () => {
    const log = createBoundedStatusLog();

    log.push('first');
    log.push('second');
    log.push('third');

    expect(log.entries()).toEqual(['first', 'second', 'third']);
  });
});
