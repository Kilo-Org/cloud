/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native assertions. */
import { createElement, type ElementType, useState } from 'react';
import type * as ReactI18next from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  FeedbackPromptProvider,
  useFeedbackPrompt,
  useFeedbackPromptRequest,
} from './use-feedback-prompt';

const View = 'View' as ElementType;
const Pressable = 'Pressable' as ElementType;

const feedback = vi.hoisted(() => ({
  showFeedbackPrompt: vi.fn(),
  requestAppRating: vi.fn(),
  sendAppFeedback: vi.fn(),
}));
// Mutable so one suite can prove both platform surfaces the hook routes to.
const platform = vi.hoisted(() => ({ inApp: true }));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Modal: 'Modal',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructiveForeground: '#FFFFFF',
    foreground: '#1A1A10',
    primary: '#00BAA9',
    primaryForeground: '#FFFFFF',
  }),
}));
vi.mock('@/lib/feedback', () => feedback);
// The platform read lives in its own module so this suite can hold the hook to
// one implementation across both platforms.
vi.mock('@/lib/feedback-prompt-platform', () => ({
  needsInAppFeedbackPrompt: () => platform.inApp,
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
/** The answer of the last request the harness made. */
let lastRequest: boolean | Promise<boolean> | undefined = undefined;

function Harness({ userId }: Readonly<{ userId: string | undefined }>) {
  const { requestPrompt, promptDialog } = useFeedbackPrompt();
  return createElement(
    View,
    null,
    createElement(Pressable, {
      className: 'request-prompt',
      onPress: () => {
        lastRequest = requestPrompt(userId);
      },
    }),
    promptDialog
  );
}

function mount(userId = 'user-1') {
  act(() => {
    const element = createElement(Harness, { userId });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing useFeedbackPrompt renderer');
  }
  return renderer.root;
}

function classNameOf(node: TestRenderer.ReactTestInstance): string {
  return typeof node.props.className === 'string' ? node.props.className : '';
}

function isType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

function press(node: TestRenderer.ReactTestInstance) {
  act(() => {
    (node.props as { onPress?: () => void }).onPress?.();
  });
}

function requestButton(root: TestRenderer.ReactTestInstance) {
  return root.find(
    node => isType(node, 'Pressable') && classNameOf(node).includes('request-prompt')
  );
}

function modals(root: TestRenderer.ReactTestInstance) {
  return root.findAll(node => isType(node, 'Modal'));
}

function answer(root: TestRenderer.ReactTestInstance, token: string) {
  press(root.find(node => isType(node, 'Pressable') && classNameOf(node).includes(token)));
}

beforeEach(() => {
  platform.inApp = true;
  lastRequest = undefined;
  feedback.showFeedbackPrompt.mockReset();
  feedback.requestAppRating.mockReset();
  feedback.sendAppFeedback.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('useFeedbackPrompt', () => {
  // The finding's defect is the Android native alert's empty message band. The
  // hook must route Android to the in-app dialog and leave iOS on the alert it
  // already renders correctly.
  it('opens the in-app dialog on Android instead of the native alert', () => {
    const root = mount();

    expect(modals(root)).toHaveLength(0);
    press(requestButton(root));

    expect(feedback.showFeedbackPrompt).not.toHaveBeenCalled();
    expect(modals(root)).toHaveLength(1);
    expect(
      root.findAll(node => isType(node, 'Text') && node.children.includes('feedback.neutralTitle'))
    ).toHaveLength(1);
  });

  it('keeps the native alert on iOS and renders no dialog', () => {
    platform.inApp = false;
    const root = mount();

    press(requestButton(root));

    expect(feedback.showFeedbackPrompt).toHaveBeenCalledWith('user-1');
    expect(modals(root)).toHaveLength(0);
  });

  it('records the positive answer through the in-app dialog and closes it', () => {
    const root = mount();

    press(requestButton(root));
    answer(root, 'bg-primary');

    expect(feedback.requestAppRating).toHaveBeenCalledTimes(1);
    expect(modals(root)).toHaveLength(0);
  });

  it('records the negative answer through the in-app dialog and closes it', () => {
    const root = mount();

    press(requestButton(root));
    answer(root, 'border-border');

    expect(feedback.sendAppFeedback).toHaveBeenCalledWith('user-1');
    expect(modals(root)).toHaveLength(0);
  });

  // The queued dialog is not a presented dialog: the claim must not record the
  // one-time prompt before the `Modal` confirms it is shown.
  it('reports presented only after the dialog confirms it is shown', async () => {
    const root = mount();

    press(requestButton(root));
    let presented: boolean | undefined = undefined;
    void (async () => {
      presented = await lastRequest;
    })();
    await act(async () => {
      await Promise.resolve();
    });
    expect(presented).toBeUndefined();

    const modal = modals(root)[0];
    const onShow = modal?.props.onShow as (() => void) | undefined;
    act(() => {
      onShow?.();
    });

    await vi.waitFor(() => {
      expect(presented).toBe(true);
    });
  });

  // The other half of the same race: a host that unmounts while the dialog is
  // queued never shows it, so the request must report that instead of promising
  // a presentation the caller then records as asked.
  it('reports that it did not present when the host unmounts before the dialog is shown', async () => {
    const root = mount();

    press(requestButton(root));
    expect(modals(root)).toHaveLength(1);

    let presented: boolean | undefined = undefined;
    void (async () => {
      presented = await lastRequest;
    })();

    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;

    await vi.waitFor(() => {
      expect(presented).toBe(false);
    });
    expect(feedback.showFeedbackPrompt).not.toHaveBeenCalled();
  });

  it('closes the in-app dialog without recording when Not now is pressed', () => {
    const root = mount();

    press(requestButton(root));
    answer(root, 'active:opacity-60');

    expect(modals(root)).toHaveLength(0);
    expect(feedback.requestAppRating).not.toHaveBeenCalled();
    expect(feedback.sendAppFeedback).not.toHaveBeenCalled();
  });
});

// The review-submit sheet's lifecycle, reproduced directly: the requesting
// surface captures the requester, unmounts (the formSheet's `router.back`
// dismissal), and only then does the deferred one-time claim fire the request.
let capturedRequest: ((userId: string | undefined) => boolean | Promise<boolean>) | undefined =
  undefined;
let unmountRequester: (() => void) | undefined = undefined;

function Requester({ userId }: Readonly<{ userId: string | undefined }>) {
  const requestPrompt = useFeedbackPromptRequest();
  capturedRequest = requestPrompt;
  return createElement(Pressable, {
    className: 'requester',
    onPress: () => {
      void requestPrompt(userId);
    },
  });
}

function ProviderHarness({ userId }: Readonly<{ userId: string | undefined }>) {
  const [requesterMounted, setRequesterMounted] = useState(true);
  unmountRequester = () => {
    setRequesterMounted(false);
  };
  return createElement(
    FeedbackPromptProvider,
    null,
    requesterMounted ? createElement(Requester, { userId }) : null
  );
}

function mountProvider(userId = 'user-1') {
  act(() => {
    const element = createElement(ProviderHarness, { userId });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing FeedbackPromptProvider renderer');
  }
  return renderer.root;
}

describe('FeedbackPromptProvider', () => {
  beforeEach(() => {
    capturedRequest = undefined;
    unmountRequester = undefined;
  });

  // The review-submit defect: the sheet dismissed (`router.back`) before the
  // deferred claim presented, and a dialog hosted in the sheet's own tree
  // unmounted with it — the Android prompt never rendered. The provider host
  // must present the prompt even when the surface that requested it is gone.
  it('presents the prompt after the requesting surface has unmounted', () => {
    const root = mountProvider();
    expect(modals(root)).toHaveLength(0);

    act(() => {
      unmountRequester?.();
    });
    expect(root.findAll(node => isType(node, 'Pressable'))).toHaveLength(0);

    act(() => {
      void capturedRequest?.('user-1');
    });

    expect(modals(root)).toHaveLength(1);
    expect(
      root.findAll(node => isType(node, 'Text') && node.children.includes('feedback.neutralTitle'))
    ).toHaveLength(1);

    // The hosted dialog still answers through the feedback module and closes.
    answer(root, 'bg-primary');
    expect(feedback.requestAppRating).toHaveBeenCalledTimes(1);
    expect(modals(root)).toHaveLength(0);
  });

  it('presents the dialog for a mounted requester too', () => {
    const root = mountProvider();

    press(root.find(node => isType(node, 'Pressable')));

    expect(feedback.showFeedbackPrompt).not.toHaveBeenCalled();
    expect(modals(root)).toHaveLength(1);
  });

  // The other half of the same race: when the host itself is gone, the request
  // cannot render the dialog. It must report that instead of promising a
  // presentation the caller then records as asked.
  it('reports that it did not present once the host has unmounted', () => {
    mountProvider();

    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;

    let presented: boolean | Promise<boolean> | undefined = undefined;
    act(() => {
      presented = capturedRequest?.('user-1');
    });

    expect(presented).toBe(false);
    expect(feedback.showFeedbackPrompt).not.toHaveBeenCalled();
  });
});
