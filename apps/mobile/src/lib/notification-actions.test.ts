/* eslint-disable max-lines -- one suite pins every action outcome, category shape, and tap fallback */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Notifications from 'expo-notifications';

import { NEEDS_INPUT_ACTION_IDS, needsInputCategoryDescriptors } from '@kilocode/notifications';

import {
  _resetDeepLinkLaunchForTests,
  _setSecureStoreForTests,
  consumePendingDeepLink,
  getPendingDeepLinkSnapshot,
  restorePersistedPendingDeepLink,
  setCurrentDeepLinkUserId,
  setPendingDeepLink,
} from './deep-link-launch';
import {
  handleNeedsInputNotificationResponse,
  isNeedsInputActionIdentifier,
  registerNeedsInputCategories,
} from './notification-actions';
import { notificationIdentifierForSession } from './needs-input-notification';
import { PENDING_DEEP_LINK_KEY } from './storage-keys';

const mocks = vi.hoisted(() => ({
  setNotificationCategoryAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  runNeedsInputInteraction: vi.fn(),
  refreshGlanceableSurfacesFromTray: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: mocks.setNotificationCategoryAsync,
  scheduleNotificationAsync: mocks.scheduleNotificationAsync,
  dismissNotificationAsync: mocks.dismissNotificationAsync,
  clearLastNotificationResponse: mocks.clearLastNotificationResponse,
}));

// The s4 entry point builds the real mobile session manager (RN / tRPC graph),
// so the suite stubs the module the lazy dynamic import resolves to.
vi.mock('./notification-action-interaction', () => ({
  runNeedsInputInteraction: mocks.runNeedsInputInteraction,
}));

// The glanceable republish reaches the same RN / tRPC graph; stub the module
// its lazy dynamic import resolves to.
vi.mock('./glanceable/approve-front-agent', () => ({
  refreshGlanceableSurfacesFromTray: mocks.refreshGlanceableSurfacesFromTray,
}));

vi.mock('@sentry/react-native', () => ({
  captureException: mocks.captureException,
}));

type RaiseData = {
  type: 'cloud_agent_session';
  cliSessionId: string;
  category: 'attention';
  attentionKind: 'permission' | 'question';
  prUrl?: string;
  organizationId?: string;
};

function raiseData(overrides: Partial<RaiseData> = {}): RaiseData {
  return {
    type: 'cloud_agent_session',
    cliSessionId: 'ses_1',
    category: 'attention',
    attentionKind: 'permission',
    ...overrides,
  };
}

type ResponseInput = {
  actionIdentifier?: string;
  identifier?: string;
  title?: string | null;
  data?: unknown;
  categoryIdentifier?: string | null;
  userText?: string;
};

function raiseResponse(input: ResponseInput = {}): Notifications.NotificationResponse {
  const {
    data = raiseData(),
    identifier = notificationIdentifierForSession('ses_1'),
    title = 'Fix the bug',
    ...rest
  } = input;
  // An OS-shaped fixture: the cast documents the OS shape the fixture stubs
  // (partial Notification fields, a bare payload as data).
  const response = {
    actionIdentifier: NEEDS_INPUT_ACTION_IDS.approve,
    notification: {
      request: {
        identifier,
        content: {
          title,
          data: data as Record<string, unknown>,
          categoryIdentifier: 'kilo-needs-input:permission',
        },
      },
    },
    ...rest,
  };
  return response as Notifications.NotificationResponse;
}

beforeEach(() => {
  _resetDeepLinkLaunchForTests();
  _setSecureStoreForTests({
    setItemAsync: vi.fn().mockResolvedValue(undefined),
    deleteItemAsync: vi.fn().mockResolvedValue(undefined),
    getItemAsync: vi.fn().mockResolvedValue(null),
  });
  mocks.setNotificationCategoryAsync.mockReset().mockResolvedValue(undefined);
  mocks.scheduleNotificationAsync.mockReset().mockResolvedValue(undefined);
  mocks.dismissNotificationAsync.mockReset().mockResolvedValue(undefined);
  mocks.clearLastNotificationResponse.mockReset();
  mocks.runNeedsInputInteraction.mockReset();
  mocks.refreshGlanceableSurfacesFromTray.mockReset().mockResolvedValue(undefined);
  mocks.captureException.mockReset();
});

describe('registerNeedsInputCategories', () => {
  it('registers one category per descriptor with its exact id and ordered actions', async () => {
    await registerNeedsInputCategories();

    const descriptors = needsInputCategoryDescriptors();
    const calls = mocks.setNotificationCategoryAsync.mock.calls as unknown as [
      string,
      Notifications.NotificationAction[],
    ][];
    expect(calls).toHaveLength(descriptors.length);
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index];
      const call = calls[index];
      expect(call?.[0]).toBe(descriptor?.id);
      expect(call?.[1].map(action => action.identifier)).toEqual([
        ...(descriptor?.actionIds ?? []),
      ]);
      for (const action of call?.[1] ?? []) {
        expect(typeof action.buttonTitle).toBe('string');
        expect(typeof action.options?.opensAppToForeground).toBe('boolean');
      }
    }
  });

  it('labels the buttons from the catalog and keeps answer actions headless', async () => {
    await registerNeedsInputCategories();

    // The unknown-pr category carries every button shape in registry order.
    expect(mocks.setNotificationCategoryAsync).toHaveBeenCalledWith('kilo-needs-input:unknown-pr', [
      {
        identifier: NEEDS_INPUT_ACTION_IDS.approve,
        buttonTitle: 'Approve',
        options: { opensAppToForeground: false },
      },
      {
        identifier: NEEDS_INPUT_ACTION_IDS.reply,
        buttonTitle: 'Reply',
        textInput: {
          submitButtonTitle: 'Send message',
          placeholder: 'Type your own answer…',
        },
        options: { opensAppToForeground: false },
      },
      {
        identifier: NEEDS_INPUT_ACTION_IDS.openSession,
        buttonTitle: 'Open session',
        options: { opensAppToForeground: true },
      },
      {
        identifier: NEEDS_INPUT_ACTION_IDS.openPr,
        buttonTitle: 'Open pull request',
        options: { opensAppToForeground: true },
      },
    ]);
    // A question category offers no Approve button; a permission one no text field.
    expect(mocks.setNotificationCategoryAsync).toHaveBeenCalledWith('kilo-needs-input:question', [
      expect.objectContaining({ identifier: NEEDS_INPUT_ACTION_IDS.reply }),
      expect.not.objectContaining({ identifier: NEEDS_INPUT_ACTION_IDS.approve }),
    ]);
    expect(mocks.setNotificationCategoryAsync).toHaveBeenCalledWith('kilo-needs-input:permission', [
      expect.not.objectContaining({ identifier: NEEDS_INPUT_ACTION_IDS.reply }),
      expect.not.objectContaining({ textInput: expect.anything() }),
    ]);
  });

  it('swallows a per-category failure and still registers the remaining categories', async () => {
    mocks.setNotificationCategoryAsync.mockRejectedValueOnce(new Error('category failed'));

    await expect(registerNeedsInputCategories()).resolves.toBeUndefined();

    expect(mocks.setNotificationCategoryAsync).toHaveBeenCalledTimes(
      needsInputCategoryDescriptors().length
    );
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          'error.operation': 'register_needs_input_category',
          'notification.category': 'kilo-needs-input:question',
        }),
      })
    );
  });
});

describe('isNeedsInputActionIdentifier', () => {
  it('recognizes the four shared action ids and nothing else', () => {
    for (const actionId of Object.values(NEEDS_INPUT_ACTION_IDS)) {
      expect(isNeedsInputActionIdentifier(actionId)).toBe(true);
    }
    expect(isNeedsInputActionIdentifier('expo.modules.notifications.actions.DEFAULT')).toBe(false);
  });
});

describe('handleNeedsInputNotificationResponse — last response', () => {
  it.each(Object.values(NEEDS_INPUT_ACTION_IDS))(
    'clears the last notification response for %s so a later cold start cannot re-dispatch it',
    async actionIdentifier => {
      mocks.runNeedsInputInteraction.mockResolvedValue('ok');

      await handleNeedsInputNotificationResponse(raiseResponse({ actionIdentifier }), {
        runInteraction: mocks.runNeedsInputInteraction,
      });

      expect(mocks.clearLastNotificationResponse).toHaveBeenCalled();
    }
  );
});

describe('handleNeedsInputNotificationResponse — approve and reply', () => {
  it('runs the approve interaction headless and replaces with the confirmation', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    const handled = await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(handled).toBe(true);
    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledWith({
      kiloSessionId: 'ses_1',
      action: 'approve',
    });
    // A quiet confirmation of the user's own action: no break-through field.
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'needs-input:ses_1',
      content: {
        title: 'Fix the bug',
        body: 'Request approved',
        data: raiseData(),
      },
      trigger: { channelId: 'needs-input' },
    });
    // Replacing under the acted-on identifier is a native replace, not a pair.
    expect(mocks.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('sends the typed text as the reply and replaces with the sent confirmation', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.reply,
        userText: 'ship it',
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledWith({
      kiloSessionId: 'ses_1',
      action: 'reply',
      text: 'ship it',
    });
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ body: 'Reply sent' }),
      })
    );
  });

  it('replaces with the failed body and keeps the actions for a retryable outcome', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('retryable');

    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'needs-input:ses_1',
      content: {
        title: 'Fix the bug',
        body: "Couldn't answer. Tap again to retry.",
        data: raiseData(),
        categoryIdentifier: 'kilo-needs-input:permission',
        interruptionLevel: 'timeSensitive',
      },
      trigger: { channelId: 'needs-input' },
    });
  });

  it('replaces with the unavailable body and drops the buttons when the raise is gone', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('unavailable');

    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'needs-input:ses_1',
      content: {
        title: 'Fix the bug',
        body: 'This request is no longer waiting.',
        data: raiseData(),
      },
      trigger: { channelId: 'needs-input' },
    });
  });

  it('resolves the runner through the lazy entry-point load when deps omit it', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    await handleNeedsInputNotificationResponse(raiseResponse());

    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledWith({
      kiloSessionId: 'ses_1',
      action: 'approve',
    });
  });

  it('resolves the glanceable republish through its lazy load when deps omit it', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.refreshGlanceableSurfacesFromTray).toHaveBeenCalledTimes(1);
  });

  it('republishes the glanceable surfaces when the answer ends the raise', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');
    const refreshGlanceableSurfaces = vi.fn().mockResolvedValue(undefined);

    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
      refreshGlanceableSurfaces,
    });

    expect(refreshGlanceableSurfaces).toHaveBeenCalledTimes(1);
  });

  it('republishes the glanceable surfaces when the raise was already gone', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('unavailable');
    const refreshGlanceableSurfaces = vi.fn().mockResolvedValue(undefined);

    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
      refreshGlanceableSurfaces,
    });

    expect(refreshGlanceableSurfaces).toHaveBeenCalledTimes(1);
  });

  it('leaves the glanceable surfaces alone while a retryable failure keeps the raise', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('retryable');
    const refreshGlanceableSurfaces = vi.fn().mockResolvedValue(undefined);

    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
      refreshGlanceableSurfaces,
    });

    expect(refreshGlanceableSurfaces).not.toHaveBeenCalled();
  });

  it('keeps the confirmation when the glanceable republish fails', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');
    const refreshGlanceableSurfaces = vi.fn().mockRejectedValue(new Error('tray down'));

    const handled = await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
      refreshGlanceableSurfaces,
    });

    expect(handled).toBe(true);
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ body: 'Request approved' }),
      })
    );
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          'error.operation': 'needs_input_action_glanceable_refresh',
        }),
      })
    );
  });

  it('treats a thrown interaction as retryable and reports it', async () => {
    mocks.runNeedsInputInteraction.mockRejectedValue(new Error('transport dead'));

    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          body: "Couldn't answer. Tap again to retry.",
          categoryIdentifier: 'kilo-needs-input:permission',
        }),
      })
    );
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ 'error.operation': 'needs_input_action_run_interaction' }),
      })
    );
  });

  it('dismisses the acted-on server push and posts the result under the session identifier', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    await handleNeedsInputNotificationResponse(raiseResponse({ identifier: 'fcm-remote-1' }), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'needs-input:ses_1' })
    );
    expect(mocks.dismissNotificationAsync).toHaveBeenCalledWith('fcm-remote-1');
  });

  it('uses the attention title when the response notification has no title', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    await handleNeedsInputNotificationResponse(raiseResponse({ title: null }), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: 'Agent needs you' }),
      })
    );
  });

  it('dismisses an answer action whose notification carries no session', async () => {
    const handled = await handleNeedsInputNotificationResponse(
      raiseResponse({
        data: { type: 'chat.message', sandboxId: 's1', conversationId: 'c1', messageId: 'm1' },
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(handled).toBe(true);
    expect(mocks.runNeedsInputInteraction).not.toHaveBeenCalled();
    expect(mocks.dismissNotificationAsync).toHaveBeenCalledWith('needs-input:ses_1');
    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('parses a headless JSON-string data envelope before dispatching', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    await handleNeedsInputNotificationResponse(
      raiseResponse({ data: JSON.stringify(raiseData()) }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledWith({
      kiloSessionId: 'ses_1',
      action: 'approve',
    });
  });

  it('falls back to retryable when the headless envelope is unparseable JSON', async () => {
    await handleNeedsInputNotificationResponse(raiseResponse({ data: '{not json' }), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.runNeedsInputInteraction).not.toHaveBeenCalled();
    expect(mocks.dismissNotificationAsync).toHaveBeenCalledWith('needs-input:ses_1');
  });
});

describe('handleNeedsInputNotificationResponse — Android headless payload', () => {
  type HeadlessResponseInput = {
    actionIdentifier?: string;
    identifier?: string;
    title?: string | null;
    dataString?: string;
    categoryIdentifier?: string | null;
    userText?: string;
  };

  /**
   * The raw serialized response the Android headless (app-closed) task hands
   * over: Expo's JS mapper never runs on that path, so the Expo push body
   * stays at `content.dataString` — a sibling of `data`, which is absent —
   * exactly as `NotificationSerializer.toBundle` builds it natively.
   */
  function headlessRaiseResponse(
    input: HeadlessResponseInput = {}
  ): Notifications.NotificationResponse {
    const {
      dataString = JSON.stringify(raiseData()),
      identifier = notificationIdentifierForSession('ses_1'),
      title = 'Fix the bug',
      ...rest
    } = input;
    // An OS-shaped fixture: the cast documents the OS shape the fixture stubs
    // (the raw headless bundle, where `dataString` sits beside `data` — a
    // field expo-notifications' own JS types omit, hence the unknown hop).
    const response = {
      actionIdentifier: NEEDS_INPUT_ACTION_IDS.approve,
      notification: {
        date: Date.now(),
        request: {
          identifier,
          content: {
            title,
            dataString,
            categoryIdentifier: 'kilo-needs-input:permission',
          },
        },
      },
      ...rest,
    };
    return response as unknown as Notifications.NotificationResponse;
  }

  it('runs the approve interaction from the unmapped dataString sibling payload', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    const handled = await handleNeedsInputNotificationResponse(headlessRaiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(handled).toBe(true);
    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledWith({
      kiloSessionId: 'ses_1',
      action: 'approve',
    });
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ body: 'Request approved' }),
      })
    );
    expect(mocks.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('sends the typed reply from the headless payload', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    await handleNeedsInputNotificationResponse(
      headlessRaiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.reply,
        userText: 'ship it',
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledWith({
      kiloSessionId: 'ses_1',
      action: 'reply',
      text: 'ship it',
    });
  });

  it('stashes the session deep link from the headless payload', async () => {
    const handled = await handleNeedsInputNotificationResponse(
      headlessRaiseResponse({ actionIdentifier: NEEDS_INPUT_ACTION_IDS.openSession }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(handled).toBe(true);
    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/agent-chat/ses_1?via=push');
  });

  it('dismisses an answer action whose headless payload is unparseable', async () => {
    const handled = await handleNeedsInputNotificationResponse(
      headlessRaiseResponse({ dataString: '{not json' }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(handled).toBe(true);
    expect(mocks.runNeedsInputInteraction).not.toHaveBeenCalled();
    expect(mocks.dismissNotificationAsync).toHaveBeenCalledWith('needs-input:ses_1');
  });
});

describe('handleNeedsInputNotificationResponse — open PR and open session', () => {
  it('stashes the PR review path for Open PR', async () => {
    const handled = await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.openPr,
        data: raiseData({ prUrl: 'https://github.com/org/repo/pull/7' }),
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(handled).toBe(true);
    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/pr-review/org/repo/7?via=push');
    expect(mocks.runNeedsInputInteraction).not.toHaveBeenCalled();
  });

  it('falls back to the session route for an Open PR without a parseable PR', async () => {
    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.openPr,
        data: raiseData({ prUrl: 'https://docs.example.com/not-a-pr' }),
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/agent-chat/ses_1?via=push');
  });

  it('stashes the session path for Open session', async () => {
    const handled = await handleNeedsInputNotificationResponse(
      raiseResponse({ actionIdentifier: NEEDS_INPUT_ACTION_IDS.openSession }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(handled).toBe(true);
    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/agent-chat/ses_1?via=push');
  });

  it('keeps an existing notification-sourced destination for a universal link', async () => {
    setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'universal-link');

    await handleNeedsInputNotificationResponse(
      raiseResponse({ actionIdentifier: NEEDS_INPUT_ACTION_IDS.openSession }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/(tabs)/(3_profile)');
  });
});

describe('handleNeedsInputNotificationResponse — session organization', () => {
  it('stashes the organization a cloud_agent_session tap carries', async () => {
    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        data: raiseData({ organizationId: 'org-9' }),
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(consumePendingDeepLink()).toEqual({
      href: '/(app)/agent-chat/ses_1?via=push',
      organizationId: 'org-9',
    });
  });

  it('stashes null when the tap carries no organization', async () => {
    await handleNeedsInputNotificationResponse(
      raiseResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT' }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(consumePendingDeepLink()).toEqual({
      href: '/(app)/agent-chat/ses_1?via=push',
      organizationId: null,
    });
  });

  it('carries the organization on Open session', async () => {
    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.openSession,
        data: raiseData({ organizationId: 'org-9' }),
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(consumePendingDeepLink()).toEqual({
      href: '/(app)/agent-chat/ses_1?via=push',
      organizationId: 'org-9',
    });
  });

  it('carries the organization on Open PR', async () => {
    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.openPr,
        data: raiseData({
          prUrl: 'https://github.com/org/repo/pull/7',
          organizationId: 'org-9',
        }),
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(consumePendingDeepLink()).toEqual({
      href: '/(app)/pr-review/org/repo/7?via=push',
      organizationId: 'org-9',
    });
  });

  it('stashes null for a tap that is not a cloud_agent_session', async () => {
    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        data: { type: 'security_finding', findingId: 'f1', scope: 'personal' },
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(consumePendingDeepLink()).toEqual({
      href: '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/f1?via=push',
      organizationId: null,
    });
  });

  it('drops a session tap captured with no account identity when the account settles signed out', async () => {
    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.openPr,
        data: raiseData({
          prUrl: 'https://github.com/org/repo/pull/7',
          organizationId: 'org-9',
        }),
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );
    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/pr-review/org/repo/7?via=push');

    // The launch settles signed out: no account owns this session destination,
    // so it must not open — with its organization switch — after a sign-in.
    setCurrentDeepLinkUserId(null);

    expect(getPendingDeepLinkSnapshot()).toBeNull();
    expect(consumePendingDeepLink()).toBeNull();
  });

  it('never restores an anonymous session tap for another account', async () => {
    const records = new Map<string, string>();
    const store = {
      setItemAsync: vi.fn(async (key: string, value: string) => {
        records.set(key, value);
        await Promise.resolve();
      }),
      deleteItemAsync: vi.fn(async (key: string) => {
        records.delete(key);
        await Promise.resolve();
      }),
      getItemAsync: vi.fn(async (key: string) => {
        await Promise.resolve();
        return records.get(key) ?? null;
      }),
    };
    _setSecureStoreForTests(store);

    await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: NEEDS_INPUT_ACTION_IDS.openSession,
        data: raiseData({ organizationId: 'org-9' }),
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );
    // The tap was captured before the account settled, so the durable record
    // carries no identity of its own.
    await vi.waitFor(() => {
      expect(records.has(PENDING_DEEP_LINK_KEY)).toBe(true);
    });

    // The process died before the account settled; another account signs in on
    // the next launch. The record restores the session and its organization for
    // that account unless the destination is bound to an identity.
    _resetDeepLinkLaunchForTests();
    _setSecureStoreForTests(store);
    setCurrentDeepLinkUserId('user-b');
    await restorePersistedPendingDeepLink();

    expect(consumePendingDeepLink()).toBeNull();
    expect(getPendingDeepLinkSnapshot()).toBeNull();
  });
});

describe('handleNeedsInputNotificationResponse — default action', () => {
  it('keeps the tap behaviour: stash the payload destination and clear the last response', async () => {
    const response = raiseResponse({
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    });

    const handled = await handleNeedsInputNotificationResponse(response, {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(handled).toBe(false);
    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/agent-chat/ses_1?via=push');
    expect(mocks.clearLastNotificationResponse).toHaveBeenCalled();
    expect(mocks.runNeedsInputInteraction).not.toHaveBeenCalled();
  });

  it('leaves the pending destination alone for malformed tap data', async () => {
    setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');

    const handled = await handleNeedsInputNotificationResponse(
      raiseResponse({
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        data: { type: 'security_finding', scope: 'personal' },
      }),
      { runInteraction: mocks.runNeedsInputInteraction }
    );

    expect(handled).toBe(false);
    expect(getPendingDeepLinkSnapshot()).toBe('/(app)/(tabs)/(3_profile)');
    expect(mocks.clearLastNotificationResponse).not.toHaveBeenCalled();
  });
});

describe('handleNeedsInputNotificationResponse — one interaction per tap', () => {
  it('shares one interaction when a warm-background tap arrives through both the listener and the headless task', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('ok');

    // Expo delivers the same response twice with the app alive in the
    // background: once to the JS response listener, once to the registered
    // background task — two separately deserialized objects with one OS
    // identity (notification identifier + action).
    const first = handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });
    const second = handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('answers a later tap on the replaced notification again after the first settles', async () => {
    mocks.runNeedsInputInteraction.mockResolvedValue('retryable');

    // The retryable result replaces the raise under the same identifier with
    // the actions kept, so a second tap carries the same OS identity — and
    // must run again.
    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });
    await handleNeedsInputNotificationResponse(raiseResponse(), {
      runInteraction: mocks.runNeedsInputInteraction,
    });

    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent dispatches of every needs-input action id, not only approve', async () => {
    for (const actionIdentifier of [
      NEEDS_INPUT_ACTION_IDS.approve,
      NEEDS_INPUT_ACTION_IDS.reply,
      NEEDS_INPUT_ACTION_IDS.openPr,
      NEEDS_INPUT_ACTION_IDS.openSession,
    ]) {
      mocks.runNeedsInputInteraction.mockResolvedValue('ok');

      // One tap per action id: the iterations must run sequentially so each
      // key's dispatches stay in flight together and never overlap another id.
      // eslint-disable-next-line no-await-in-loop -- sequential per-action-id taps
      await Promise.all([
        handleNeedsInputNotificationResponse(raiseResponse({ actionIdentifier }), {
          runInteraction: mocks.runNeedsInputInteraction,
        }),
        handleNeedsInputNotificationResponse(raiseResponse({ actionIdentifier }), {
          runInteraction: mocks.runNeedsInputInteraction,
        }),
      ]);
    }

    // One interaction per action id: approve once, reply once; the two opens
    // never reach the runner.
    expect(mocks.runNeedsInputInteraction).toHaveBeenCalledTimes(2);
  });
});
