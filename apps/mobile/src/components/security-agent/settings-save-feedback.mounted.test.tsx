// The Security Agent settings screens need a durable line for a refused save.
// `SettingsSaveButton` swallows the save's rejection, so the toast was the only
// trace of a refusal: a few seconds of copy, then the unchanged screen with the
// draft still dirty. This suite drives the shared hook behind that line: it
// keeps a one-line slot reserved before anything is refused, fills that slot in
// place with the error's sentence (re-translated from the catalog, never the
// server's English text) until a save succeeds, and hands the rejection back to
// the caller that decides navigation from it.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { useSettingsSaveFeedback } from './settings-save-feedback';

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'android' },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const probe = {
  run: null as ((save: () => Promise<void>) => Promise<void>) | null,
};

function Probe() {
  const feedback = useSettingsSaveFeedback();
  probe.run = feedback.run;
  return feedback.node;
}

function mount() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Probe));
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function run(save: () => Promise<void>) {
  const current = probe.run;
  if (current === null) {
    throw new Error('the hook did not render');
  }
  return current(save);
}

function statusMessage(renderer: TestRenderer.ReactTestRenderer): string | null {
  const nodes = renderer.root.findAllByType('Text');
  const [first] = nodes;
  if (first === undefined) {
    return null;
  }
  return String(first.props.children);
}

/** The line's slot — the wrapper the hook renders in every state. */
function slot(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const slots = renderer.root.findAll(
    node =>
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('justify-center px-6')
  );
  if (slots.length !== 1) {
    throw new Error(`expected one reserved slot, found ${slots.length}`);
  }
  const [only] = slots;
  if (!only) {
    throw new Error('the reserved slot is missing');
  }
  return only;
}

describe('useSettingsSaveFeedback', () => {
  beforeEach(async () => {
    probe.run = null;
    await i18n.changeLanguage('en');
  });

  it('reserves the line height before a save fails', () => {
    const renderer = mount();

    // The slot is there from the first commit, tall enough for the two lines
    // this copy wraps to, so the body the hook sits above never moves when the
    // line fills in.
    expect(slot(renderer).props.className).toBe('min-h-10 justify-center px-6');
    // ...and it says nothing: an empty message renders no text and announces
    // nothing, rather than leaving an empty live region behind.
    expect(renderer.root.findAllByType('Text')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('fills the slot with the catalog sentence for a lapsed organization trial', async () => {
    const refusal = Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
      data: { code: 'FORBIDDEN' },
    });
    const renderer = mount();

    await act(async () => {
      await expect(run(() => Promise.reject(refusal))).rejects.toBe(refusal);
    });

    expect(statusMessage(renderer)).toBe(i18n.t('common.organizationTrialEnded'));
    // The same slot holds the sentence: the line swaps in place instead of
    // pushing the scrolling body down.
    expect(slot(renderer).findAllByType('Text')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders the localized generic sentence for an unrecognised failure', async () => {
    const refusal = Object.assign(new Error('Upstream refused the write: quota exceeded'), {
      data: { code: 'INTERNAL_SERVER_ERROR' },
    });
    const renderer = mount();

    await act(async () => {
      await expect(run(() => Promise.reject(refusal))).rejects.toBe(refusal);
    });

    const message = statusMessage(renderer);
    expect(message).toBe(i18n.t('securityAgent.mutations.actionFailed'));
    expect(message).not.toContain('quota exceeded');

    act(() => {
      renderer.unmount();
    });
  });

  it('rethrows the rejection unchanged', async () => {
    const refusal = new Error('the caller decides navigation from this rejection');
    const renderer = mount();

    await act(async () => {
      await expect(run(() => Promise.reject(refusal))).rejects.toBe(refusal);
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the refusal while a retry is in flight and clears it on success', async () => {
    const refusal = Object.assign(new Error('Upstream refused the write'), {
      data: { code: 'INTERNAL_SERVER_ERROR' },
    });
    const renderer = mount();

    await act(async () => {
      await expect(run(() => Promise.reject(refusal))).rejects.toBe(refusal);
    });
    const refusalMessage = statusMessage(renderer);
    expect(refusalMessage).not.toBeNull();

    // A re-render while the refusal is parked must not drop it.
    act(() => {
      renderer.update(createElement(Probe));
    });
    expect(statusMessage(renderer)).toBe(refusalMessage);

    // A second attempt in flight keeps the previous explanation on screen
    // instead of blinking it off and back for a refusal the server answers in
    // milliseconds.
    const { promise: inFlight, resolve: release } = Promise.withResolvers<undefined>();
    const retry = run(() => inFlight);
    expect(statusMessage(renderer)).toBe(refusalMessage);

    release(undefined);
    await act(async () => {
      await retry;
    });

    // The sentence clears; the slot stays, so the body does not move back up.
    expect(renderer.root.findAllByType('Text')).toHaveLength(0);
    expect(slot(renderer).props.className).toBe('min-h-10 justify-center px-6');

    act(() => {
      renderer.unmount();
    });
  });
});
