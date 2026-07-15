import { describe, expect, it, vi } from 'vitest';

import {
  completeHappyPath,
  handlePromptPartial,
  PROMPT_PARTIAL_TOAST,
  SESSION_CREATED_EVENT,
  SESSION_CREATED_EVENT_SURFACE,
  SESSION_DETAIL_PATH_PREFIX,
} from './local-session-create-effects';

const SESSION_ID = 'sess-abc';

describe('completeHappyPath', () => {
  it('invalidates, captures analytics, fires success haptic, then navigates — in that order', async () => {
    const events: string[] = [];
    const invalidateCaches = vi.fn();
    invalidateCaches.mockImplementation(() => {
      events.push('invalidate');
    });
    const captureEvent = vi.fn((name, properties) => {
      events.push(`event:${name}:${JSON.stringify(properties)}`);
    });
    const notificationHaptic = vi.fn(kind => {
      events.push(`haptic:${kind}`);
    });
    const navigate = vi.fn(path => {
      events.push(`navigate:${path}`);
    });

    await completeHappyPath(SESSION_ID, {
      invalidateCaches,
      captureEvent,
      notificationHaptic,
      navigate,
    });

    expect(events).toEqual([
      'invalidate',
      `event:${SESSION_CREATED_EVENT}:${JSON.stringify({ surface: SESSION_CREATED_EVENT_SURFACE })}`,
      'haptic:success',
      `navigate:${SESSION_DETAIL_PATH_PREFIX}${SESSION_ID}`,
    ]);
  });
});

describe('handlePromptPartial', () => {
  it('invalidates, fires the fixed info toast, then navigates — in that order', async () => {
    const events: string[] = [];
    const invalidateCaches = vi.fn();
    invalidateCaches.mockImplementation(() => {
      events.push('invalidate');
    });
    const showInfo = vi.fn(message => {
      events.push(`info:${message}`);
    });
    const navigate = vi.fn(path => {
      events.push(`navigate:${path}`);
    });

    const result = await handlePromptPartial(SESSION_ID, {
      invalidateCaches,
      showInfo,
      navigate,
    });

    expect(result).toEqual({ invalidationFailed: false });
    expect(events).toEqual([
      'invalidate',
      `info:${PROMPT_PARTIAL_TOAST}`,
      `navigate:${SESSION_DETAIL_PATH_PREFIX}${SESSION_ID}`,
    ]);
  });

  it('still surfaces the info toast and navigates when invalidation throws', async () => {
    const events: string[] = [];
    const invalidateCaches = vi.fn();
    invalidateCaches.mockImplementation(() => {
      events.push('invalidate');
      throw new Error('cache down');
    });
    const showInfo = vi.fn(message => {
      events.push(`info:${message}`);
    });
    const navigate = vi.fn(path => {
      events.push(`navigate:${path}`);
    });

    const result = await handlePromptPartial(SESSION_ID, {
      invalidateCaches,
      showInfo,
      navigate,
    });

    expect(result).toEqual({ invalidationFailed: true });
    expect(events).toEqual([
      'invalidate',
      `info:${PROMPT_PARTIAL_TOAST}`,
      `navigate:${SESSION_DETAIL_PATH_PREFIX}${SESSION_ID}`,
    ]);
  });
});
