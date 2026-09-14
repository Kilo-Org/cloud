import { describe, expect, it, vi } from 'vitest';

import { dateTimeFormat } from '@/lib/intl-cache';
import { CHAT_TOOL_NAMES, chatTools, deviceZone } from './tools';

// A zone from the first line: the tool set is built when the module loads.
vi.mock('@/lib/intl-cache', () => ({
  dateTimeFormat: vi.fn(() => ({ resolvedOptions: () => ({ timeZone: 'Europe/Amsterdam' }) })),
}));

const resolvesTo = (timeZone: string) => {
  vi.mocked(dateTimeFormat).mockReturnValue({
    resolvedOptions: () => ({ timeZone }),
  } as unknown as Intl.DateTimeFormat);
};

/**
 * What a chat offers the model.
 *
 * One tool, and the zone it reports local time in. The zone is the part that
 * can go wrong on a device: a runtime with no zone data must give UTC alone
 * rather than a local time that is somebody else's.
 */

describe('the tools a chat offers', () => {
  it('is the clock, and nothing that belongs to a working harness', () => {
    expect(CHAT_TOOL_NAMES).toEqual(['time']);
  });

  it('answers with the tool itself, ready to run', () => {
    const [tool] = chatTools();
    expect(tool?.definition.name).toBe('time');
    expect(tool?.run).toBeTypeOf('function');
  });
});

describe('the zone local time is reported in', () => {
  it('is the one the device is set to', () => {
    resolvesTo('Europe/Amsterdam');
    expect(deviceZone()).toBe('Europe/Amsterdam');
  });

  it('is none when the runtime cannot name one, so the answer stays UTC', () => {
    resolvesTo('');
    expect(deviceZone()).toBeUndefined();
  });
});
