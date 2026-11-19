import { Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  answerSettingsConfirm,
  confirmSettingChange,
  forgetSettingsConfirm,
  getSettingsConfirmRequest,
  requestSettingsConfirmChange,
  setSettingsConfirmHostMounted,
  settleAllSettingsConfirms,
  subscribeSettingsConfirm,
} from './confirm';

const SUMMARY = 'Change "trustedHosts" to ["a"]';

beforeEach(() => {
  settleAllSettingsConfirms(false);
  setSettingsConfirmHostMounted(false);
});

afterEach(() => {
  settleAllSettingsConfirms(false);
  setSettingsConfirmHostMounted(false);
});

describe('requestSettingsConfirmChange', () => {
  it('publishes the request to the head and delivers the answer to its resolver', () => {
    const answers: boolean[] = [];
    const id = requestSettingsConfirmChange(SUMMARY, confirmed => {
      answers.push(confirmed);
    });

    expect(getSettingsConfirmRequest()).toMatchObject({ id, summary: SUMMARY });
    expect(getSettingsConfirmRequest()?.withdrawn).toBe(false);

    answerSettingsConfirm(id, false);

    expect(answers).toEqual([false]);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  it('draws the next request only after the head is answered', () => {
    const idle = () => undefined;
    const firstId = requestSettingsConfirmChange(SUMMARY, idle);
    const secondId = requestSettingsConfirmChange('Change "theme" to "dark"', idle);

    expect(getSettingsConfirmRequest()).toMatchObject({ id: firstId, summary: SUMMARY });

    answerSettingsConfirm(firstId, true);

    expect(getSettingsConfirmRequest()).toMatchObject({
      id: secondId,
      summary: 'Change "theme" to "dark"',
    });
  });

  it('answers nothing for a late answer for an answered request', () => {
    const answers: boolean[] = [];
    const id = requestSettingsConfirmChange(SUMMARY, confirmed => {
      answers.push(confirmed);
    });

    answerSettingsConfirm(id + 100, false);
    expect(answers).toEqual([]);
    expect(getSettingsConfirmRequest()).toBeDefined();

    answerSettingsConfirm(id, true);
    answerSettingsConfirm(id, false);

    expect(answers).toEqual([true]);
  });
});

describe('settleAllSettingsConfirms', () => {
  it('settles every waiting request with the given answer and empties the queue', () => {
    const answers: boolean[] = [];
    requestSettingsConfirmChange('First', confirmed => {
      answers.push(confirmed);
    });
    requestSettingsConfirmChange('Second', confirmed => {
      answers.push(confirmed);
    });

    settleAllSettingsConfirms(false);

    expect(answers).toEqual([false, false]);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });
});

describe('confirmSettingChange', () => {
  it('refuses the change when no host is mounted', async () => {
    await expect(Effect.runPromise(confirmSettingChange(SUMMARY))).resolves.toBe(false);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  it('resolves with the answer its request receives', async () => {
    setSettingsConfirmHostMounted(true);
    const pending = Effect.runPromise(confirmSettingChange(SUMMARY));

    const request = getSettingsConfirmRequest();
    if (request === undefined) {
      throw new Error('the request was not published');
    }
    expect(request.summary).toBe(SUMMARY);

    answerSettingsConfirm(request.id, true);

    await expect(pending).resolves.toBe(true);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  it('marks the request withdrawn when the call is interrupted, and answers it nothing', async () => {
    setSettingsConfirmHostMounted(true);
    const fiber = Effect.runFork(confirmSettingChange(SUMMARY));

    await vi.waitFor(() => {
      expect(getSettingsConfirmRequest()).toBeDefined();
    });
    const id = getSettingsConfirmRequest()?.id;
    if (id === undefined) {
      throw new Error('the request was not published');
    }

    await Effect.runPromise(Fiber.interrupt(fiber));

    // Withdrawn, not removed: the request keeps its place in the queue until
    // the host has drawn out the sheet it presented and reports it.
    expect(getSettingsConfirmRequest()).toMatchObject({ id, withdrawn: true });

    // A late answer for the withdrawn request settles nothing.
    answerSettingsConfirm(id, true);
    expect(getSettingsConfirmRequest()).toMatchObject({ id, withdrawn: true });

    // The host removes the request after the sheet reported its dismissal.
    forgetSettingsConfirm(id);
    expect(getSettingsConfirmRequest()).toBeUndefined();
  });

  // The listener answers while the store is mid-publish. The resolver must
  // already be registered when the listeners hear about the request, so a
  // settle from inside the publish still reaches the waiting tool call.
  it('resolves false when the request is settled inside the notify window', async () => {
    // The listener answers every request once, the way a native answer layer
    // would: `settleAllSettingsConfirms` re-notifies its emptying, so the
    // guard keeps an already-answered window from re-entering.
    const answered = new Set<number>();
    const unsubscribe = subscribeSettingsConfirm(() => {
      const request = getSettingsConfirmRequest();
      if (request !== undefined && !answered.has(request.id)) {
        answered.add(request.id);
        settleAllSettingsConfirms(false);
      }
    });
    try {
      setSettingsConfirmHostMounted(true);
      await expect(Effect.runPromise(confirmSettingChange(SUMMARY))).resolves.toBe(false);
      expect(getSettingsConfirmRequest()).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
