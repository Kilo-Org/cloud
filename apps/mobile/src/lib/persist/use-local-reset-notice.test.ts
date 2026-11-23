/* eslint-disable require-await -- the fake seams settle without an await because they answer immediately */
import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The hook imports the native encrypted-kv chain (expo-sqlite, expo-crypto,
// Sentry); this suite exercises the hook's own state machine through the two
// seams it reads, so the real module never loads.
const kvMock = vi.hoisted(() => ({
  readPersistedResetNotice: vi.fn(async (): Promise<boolean> => false),
  clearPersistedResetNotice: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

// React 19 drops a state update on an unmounted component without a warning, so
// a render cannot witness one. This recorder counts the setter calls the hook
// makes while the test has armed it, which is the only way to prove the hook
// attempted none after unmount. The wrapper delegates to the real `useState`,
// so every other case behaves exactly as it would unmocked.
const stateRecorder = vi.hoisted(() => ({ armed: false, calls: 0 }));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>();
  const useState = <T>(initial: T | (() => T)) => {
    const [value, setValue] = actual.useState(initial);
    const setValueRecorded = (next: T | ((prev: T) => T)): void => {
      if (stateRecorder.armed) {
        stateRecorder.calls += 1;
      }
      setValue(next);
    };
    return [value, setValueRecorded] as const;
  };
  return { ...actual, useState };
});

/* eslint-disable import/first */
import { useLocalResetNotice, type LocalResetNoticeState } from './use-local-reset-notice';
/* eslint-enable import/first */

beforeEach(() => {
  vi.clearAllMocks();
  stateRecorder.armed = false;
  stateRecorder.calls = 0;
  kvMock.readPersistedResetNotice.mockImplementation(async () => false);
  kvMock.clearPersistedResetNotice.mockImplementation(async () => undefined);
});

// The hook's only asynchronous work is an awaited read and the clear it issues,
// so one settled act pass over a handful of already-resolved promise ticks is
// enough: no real timer is involved and nothing here waits on wall-clock time.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.all([Promise.resolve(), Promise.resolve(), Promise.resolve()]);
  });
}

/** Reports each render's state so a case can assert on the published sequence. */
function NoticeHarness({ onRender }: { onRender: (state: LocalResetNoticeState) => void }) {
  const state = useLocalResetNotice();
  onRender(state);
  return null;
}

function mountHarness(renders: LocalResetNoticeState[]): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(
      React.createElement(NoticeHarness, {
        onRender: state => {
          renders.push(state);
        },
      })
    );
  });
  if (!rendererRef.current) {
    throw new Error('renderer not created');
  }
  return rendererRef.current;
}

/** The kinds published so far, in render order. */
function kinds(renders: LocalResetNoticeState[]): string[] {
  return renders.map(render => render.notice.kind);
}

/** The state of the latest render; its `dismiss` is the hook's stable callback. */
function latest(renders: LocalResetNoticeState[]): LocalResetNoticeState {
  const state = renders.at(-1);
  if (!state) {
    throw new Error('the harness rendered nothing');
  }
  return state;
}

describe('useLocalResetNotice', () => {
  it('starts in loading and settles to present when the marker read answers true', async () => {
    kvMock.readPersistedResetNotice.mockImplementationOnce(async () => true);
    const renders: LocalResetNoticeState[] = [];
    const renderer = mountHarness(renders);

    // The first render must not claim "no loss" before the read answers.
    expect(kinds(renders)).toEqual(['loading']);

    await flushMicrotasks();

    expect(kinds(renders)).toEqual(['loading', 'present']);
    expect(kvMock.readPersistedResetNotice).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('settles to absent when the marker read answers false', async () => {
    kvMock.readPersistedResetNotice.mockImplementationOnce(async () => false);
    const renders: LocalResetNoticeState[] = [];
    const renderer = mountHarness(renders);

    expect(kinds(renders)).toEqual(['loading']);

    await flushMicrotasks();

    expect(kinds(renders)).toEqual(['loading', 'absent']);

    act(() => {
      renderer.unmount();
    });
  });

  it('publishes absent before the clear resolves and clears the marker once', async () => {
    kvMock.readPersistedResetNotice.mockImplementationOnce(async () => true);
    const clear = Promise.withResolvers<undefined>();
    kvMock.clearPersistedResetNotice.mockImplementationOnce(async () => clear.promise);
    const renders: LocalResetNoticeState[] = [];
    const renderer = mountHarness(renders);
    await flushMicrotasks();
    // The read found the marker, so the render before the dismissal carries the
    // notice.
    expect(kinds(renders).at(-1)).toBe('present');

    act(() => {
      latest(renders).dismiss();
    });

    // The notice is gone before the clear settles: the person's decision is not
    // held open by keychain latency.
    expect(kinds(renders).at(-1)).toBe('absent');
    expect(kvMock.clearPersistedResetNotice).toHaveBeenCalledTimes(1);

    await act(async () => {
      clear.resolve(undefined);
    });
    await flushMicrotasks();

    // Settling the clear neither repaints the notice nor repeats the clear.
    expect(kinds(renders).at(-1)).toBe('absent');
    expect(kvMock.clearPersistedResetNotice).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('calls the clear on every dismiss: the hook has no second-dismiss guard', async () => {
    kvMock.readPersistedResetNotice.mockImplementationOnce(async () => true);
    const renders: LocalResetNoticeState[] = [];
    const renderer = mountHarness(renders);
    await flushMicrotasks();

    act(() => {
      latest(renders).dismiss();
    });
    act(() => {
      latest(renders).dismiss();
    });

    // `dismiss` has no "already dismissed" branch: each call bumps the read
    // token, republishes absent, and issues one clear.
    expect(kvMock.clearPersistedResetNotice).toHaveBeenCalledTimes(2);
    expect(kinds(renders).at(-1)).toBe('absent');

    act(() => {
      renderer.unmount();
    });
  });

  it('a read that lands after a dismissal leaves the notice absent', async () => {
    const read = Promise.withResolvers<boolean>();
    kvMock.readPersistedResetNotice.mockImplementationOnce(() => read.promise);
    const renders: LocalResetNoticeState[] = [];
    const renderer = mountHarness(renders);
    expect(kinds(renders)).toEqual(['loading']);

    act(() => {
      latest(renders).dismiss();
    });
    const rendersAtDismiss = renders.length;
    expect(kinds(renders).at(-1)).toBe('absent');

    // The marker says the store was reset, but it answers after the person
    // dismissed the notice: it must not paint back over that decision.
    read.resolve(true);
    await flushMicrotasks();

    expect(renders.slice(rendersAtDismiss).map(render => render.notice.kind)).not.toContain(
      'present'
    );
    expect(kinds(renders).at(-1)).toBe('absent');

    act(() => {
      renderer.unmount();
    });
  });

  it('a read that lands after unmount publishes nothing', async () => {
    const read = Promise.withResolvers<boolean>();
    kvMock.readPersistedResetNotice.mockImplementationOnce(() => read.promise);
    const renders: LocalResetNoticeState[] = [];
    const renderer = mountHarness(renders);
    expect(kinds(renders)).toEqual(['loading']);

    act(() => {
      renderer.unmount();
    });
    const rendersAtUnmount = renders.length;

    // Arm the recorder only now: every setter call counted from here belongs to
    // the unmounted instance, which React would otherwise swallow silently.
    stateRecorder.armed = true;
    read.resolve(true);
    await flushMicrotasks();

    // The unmounted instance applies nothing: no state update was attempted and
    // no render carries the notice it would have published.
    expect(renders.length).toBe(rendersAtUnmount);
    expect(kinds(renders)).not.toContain('present');
    expect(stateRecorder.calls).toBe(0);
  });

  it('a refused clear stays silent: dismiss never throws and the notice stays absent', async () => {
    kvMock.readPersistedResetNotice.mockImplementationOnce(async () => true);
    const renders: LocalResetNoticeState[] = [];
    const renderer = mountHarness(renders);
    await flushMicrotasks();
    expect(kinds(renders).at(-1)).toBe('present');

    // The real `clearPersistedResetNotice` delegates to a delete helper that
    // returns `false` instead of rejecting, so this rejection is harsher than
    // the contract. The hook issues the clear as `void
    // clearPersistedResetNotice()` with no catch: it never observes the
    // outcome, so it neither throws into `dismiss` nor handles the rejection.
    // The test therefore owns the synthetic rejection: it awaits it and asserts
    // the rejection it saw, which keeps a harsher-than-real callee from
    // surfacing outside the test's sight.
    const refused = Promise.withResolvers<undefined>();
    const refusal = new Error('keychain refused the clear');
    // Not `async`: an `async` wrapper would adopt the rejection into a second
    // promise that the hook drops, and the runner would see that one rejected
    // with no handler. Handing the hook `refused.promise` itself keeps the only
    // rejection the test's own await below.
    kvMock.clearPersistedResetNotice.mockImplementationOnce(() => refused.promise);

    let thrown: unknown = undefined;
    act(() => {
      try {
        latest(renders).dismiss();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeUndefined();
    expect(kinds(renders).at(-1)).toBe('absent');

    act(() => {
      refused.reject(refusal);
    });
    // The hook attached no handler, so the rejection is the caller's: awaiting
    // the same promise here observes it without the runner reporting it.
    await expect(refused.promise).rejects.toBe(refusal);
    await flushMicrotasks();

    // The dismissal stands: a failed clear leaves the durable marker, which is
    // the documented outcome (the notice returns on the next launch).
    expect(kinds(renders).at(-1)).toBe('absent');

    act(() => {
      renderer.unmount();
    });
  });
});
