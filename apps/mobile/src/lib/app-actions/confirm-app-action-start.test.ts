import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmAppActionStart } from './confirm-app-action-start';

const mocks = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }));

/** The message the confirmation passed to the native alert, and nothing else. */
function shownMessage(): string {
  const call = mocks.alert.mock.calls.at(0);
  if (call === undefined) {
    throw new Error('the confirmation did not open an alert');
  }
  return String(call[1]);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('confirmAppActionStart', () => {
  it('shows the whole prompt the run will use', () => {
    const prompt = `${'First sentence. '.repeat(40)}Then the last instruction.`;
    void confirmAppActionStart({ prompt, repository: 'owner/repo' });
    const message = shownMessage();
    expect(message).toContain('Then the last instruction.');
    expect(message).toContain(prompt.trim());
    expect(message).not.toContain('…');
  });

  it('collapses whitespace in the prompt for the one-line alert', () => {
    void confirmAppActionStart({ prompt: '  fix\n\nthe   build  ', repository: 'owner/repo' });
    expect(shownMessage()).toContain('fix the build');
  });

  it('bounds the repository label while the run keeps its full value', () => {
    const repository = 'owner/'.concat('r'.repeat(400));
    void confirmAppActionStart({ prompt: 'fix the build', repository });
    const message = shownMessage();
    expect(message).toContain(`${repository.slice(0, 240)}…`);
    expect(message).not.toContain(repository);
  });

  it('names the recent repository when the request names none', () => {
    void confirmAppActionStart({ prompt: 'fix the build' });
    expect(shownMessage()).toContain('your most recent repository');
  });

  it('resolves false when the person cancels', async () => {
    const answer = confirmAppActionStart({ prompt: 'fix the build' });
    const buttons = mocks.alert.mock.calls.at(0)?.[2] as { text: string; onPress: () => void }[];
    buttons[0]?.onPress();
    await expect(answer).resolves.toBe(false);
  });

  it('resolves true when the person continues', async () => {
    const answer = confirmAppActionStart({ prompt: 'fix the build' });
    const buttons = mocks.alert.mock.calls.at(0)?.[2] as { text: string; onPress: () => void }[];
    buttons[1]?.onPress();
    await expect(answer).resolves.toBe(true);
  });
});
