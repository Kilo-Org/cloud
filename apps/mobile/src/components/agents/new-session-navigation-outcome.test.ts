import { describe, expect, it } from 'vitest';

import {
  awaitComposerTop,
  composerOnTop,
  isComposerRouteName,
} from './new-session-navigation-outcome';

function stack(...names: string[]) {
  return { index: names.length - 1, routes: names.map(name => ({ name })) };
}

describe('isComposerRouteName', () => {
  it('names the composer by its route name or by a full href', () => {
    expect(isComposerRouteName('agent-chat/new')).toBe(true);
    expect(isComposerRouteName('/(app)/agent-chat/new')).toBe(true);
    expect(isComposerRouteName('/(app)/agent-chat/new?cloneFromKiloSessionId=ses_1')).toBe(true);
  });

  it('does not name the session route or a sibling agent route', () => {
    expect(isComposerRouteName('agent-chat/[session-id]')).toBe(false);
    expect(isComposerRouteName('/(app)/agent-chat/ses_000000000005PagedHistory01')).toBe(false);
    expect(isComposerRouteName('agent-chat/model-picker')).toBe(false);
    expect(isComposerRouteName(undefined)).toBe(false);
  });
});

describe('composerOnTop', () => {
  it('reads the route the stack reports at its own index', () => {
    expect(composerOnTop(stack('(tabs)', 'agent-chat/[session-id]', 'agent-chat/new'))).toBe(true);
    expect(composerOnTop(stack('(tabs)', 'agent-chat/[session-id]'))).toBe(false);
  });

  it('is false without a state to read', () => {
    expect(composerOnTop(undefined)).toBe(false);
  });
});

describe('awaitComposerTop', () => {
  it('answers at once when the composer is already the top route', async () => {
    const delays: number[] = [];
    const opened = await awaitComposerTop({
      readState: () => stack('(tabs)', 'agent-chat/new'),
      sleep: ms => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(opened).toBe(true);
    expect(delays).toEqual([]);
  });

  it('re-checks while the navigator catches up, and stops when it lands', async () => {
    const states = [
      stack('(tabs)', 'agent-chat/[session-id]'),
      stack('(tabs)', 'agent-chat/[session-id]'),
      stack('(tabs)', 'agent-chat/[session-id]', 'agent-chat/new'),
    ];
    let read = 0;
    const delays: number[] = [];
    const opened = await awaitComposerTop({
      readState: () => {
        const state = states[Math.min(read, states.length - 1)];
        read += 1;
        return state;
      },
      sleep: ms => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(opened).toBe(true);
    expect(delays).toEqual([250, 650]);
  });

  it('reports a push that never landed', async () => {
    const delays: number[] = [];
    const opened = await awaitComposerTop({
      readState: () => stack('(tabs)', 'agent-chat/[session-id]'),
      sleep: ms => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(opened).toBe(false);
    expect(delays).toEqual([250, 650]);
  });
});
