import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({ Platform: platform }));

describe('needsInAppFeedbackPrompt', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  // Android's native alert keeps an empty message band between its title and
  // its three actions (`Alert.js` sends `message || ''`), so the prompt needs
  // the in-app dialog there.
  it('needs the in-app dialog on Android', async () => {
    const { needsInAppFeedbackPrompt } = await import('./feedback-prompt-platform');

    expect(needsInAppFeedbackPrompt()).toBe(true);
  });

  // iOS passes the message through as undefined and lays the alert out
  // compactly, so the native alert stays.
  it('keeps the native alert on iOS', async () => {
    platform.OS = 'ios';
    const { needsInAppFeedbackPrompt } = await import('./feedback-prompt-platform');

    expect(needsInAppFeedbackPrompt()).toBe(false);
  });
});
