import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmAppActionStart } from './confirm-app-action-start';

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  addEventListener: vi.fn(),
  state: 'active' as string,
}));

vi.mock('react-native', () => ({
  Alert: { alert: mocks.alert },
  AppState: {
    get currentState(): string {
      return mocks.state;
    },
    addEventListener: mocks.addEventListener,
  },
}));

type AlertButton = { text: string; onPress: () => void };

/** The alert the confirmation opened, after the activation gate lets it. */
async function openedAlert(): Promise<{ message: string; buttons: AlertButton[] }> {
  await vi.waitFor(() => {
    expect(mocks.alert).toHaveBeenCalled();
  });
  const call = mocks.alert.mock.calls.at(0);
  if (call === undefined) {
    throw new Error('the confirmation did not open an alert');
  }
  return { message: String(call[1]), buttons: call[2] as AlertButton[] };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state = 'active';
  mocks.addEventListener.mockReturnValue({ remove: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('confirmAppActionStart', () => {
  it('shows the whole prompt the run will use', async () => {
    const prompt = `${'First sentence. '.repeat(40)}Then the last instruction.`;
    void confirmAppActionStart({ prompt, repository: 'owner/repo' });
    const { message } = await openedAlert();
    expect(message).toContain('Then the last instruction.');
    expect(message).toContain(prompt.trim());
    expect(message).not.toContain('…');
  });

  it('collapses whitespace in the prompt for the one-line alert', async () => {
    void confirmAppActionStart({ prompt: '  fix\n\nthe   build  ', repository: 'owner/repo' });
    const { message } = await openedAlert();
    expect(message).toContain('fix the build');
  });

  it('bounds the repository label while the run keeps its full value', async () => {
    const repository = 'owner/'.concat('r'.repeat(400));
    void confirmAppActionStart({ prompt: 'fix the build', repository });
    const { message } = await openedAlert();
    expect(message).toContain(`${repository.slice(0, 240)}…`);
    expect(message).not.toContain(repository);
  });

  it('names the recent repository when the request names none', async () => {
    void confirmAppActionStart({ prompt: 'fix the build' });
    const { message } = await openedAlert();
    expect(message).toContain('your most recent repository');
  });

  it('resolves false when the person cancels', async () => {
    const answer = confirmAppActionStart({ prompt: 'fix the build' });
    const { buttons } = await openedAlert();
    buttons[0]?.onPress();
    await expect(answer).resolves.toBe(false);
  });

  it('resolves true when the person continues', async () => {
    const answer = confirmAppActionStart({ prompt: 'fix the build' });
    const { buttons } = await openedAlert();
    buttons[1]?.onPress();
    await expect(answer).resolves.toBe(true);
  });

  it('shows no alert until a backgrounded app reaches an activity', async () => {
    mocks.state = 'background';
    let onChange: (state: string) => void = () => {};
    mocks.addEventListener.mockImplementation(
      (_event: string, listener: (state: string) => void) => {
        onChange = listener;
        return { remove: vi.fn() };
      }
    );

    const answer = confirmAppActionStart({ prompt: 'fix the build' });
    await Promise.resolve();
    expect(mocks.alert).not.toHaveBeenCalled();

    onChange('active');
    const { buttons } = await openedAlert();
    buttons[0]?.onPress();
    await expect(answer).resolves.toBe(false);
  });

  it('refuses without an alert when the app never reaches an activity', async () => {
    vi.useFakeTimers();
    mocks.state = 'background';
    const remove = vi.fn();
    mocks.addEventListener.mockReturnValue({ remove });

    const answer = confirmAppActionStart({ prompt: 'fix the build' });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(answer).resolves.toBe(false);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });
});
