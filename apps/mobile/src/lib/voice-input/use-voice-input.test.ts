/* eslint-disable max-lines -- the toggle consent-gating suite shares the createVoiceInputActions harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import {
  type VoiceInputControllerSnapshot,
  type VoiceInputStartOptions,
} from './voice-input-controller';
import {
  createVoiceInputActions,
  shouldAbortVoiceInputForOwner,
  showFeedback,
} from './use-voice-input-actions';
import { __resetVoiceInputLanguageTagCacheForTests } from './voice-input-language';

const hapticsMock = vi.hoisted(() => ({
  impactAsync: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
}));

const alertMock = vi.hoisted(() => ({
  alert: vi.fn(),
}));

const linkingMock = vi.hoisted(() => ({
  openSettings: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

const localizationMock = vi.hoisted(() => ({
  getLocales: vi.fn<() => { languageTag: string }[]>(() => [{ languageTag: 'en-US' }]),
}));

const getSupportedLocalesMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ locales: string[]; installedLocales: string[] }>>().mockResolvedValue({
    locales: ['en-US', 'nl-NL'],
    installedLocales: ['en-US'],
  })
);

const triggerOfflineModelDownloadMock = vi.hoisted(() =>
  vi
    .fn<(options: { locale: string }) => Promise<{ status: string; message: string }>>()
    .mockResolvedValue({ status: 'download_success', message: '' })
);

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  impactAsync: hapticsMock.impactAsync,
}));

vi.mock('expo-localization', () => ({
  getLocales: localizationMock.getLocales,
}));

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    getSupportedLocales: getSupportedLocalesMock,
    androidTriggerOfflineModelDownload: triggerOfflineModelDownloadMock,
  },
}));

vi.mock('sonner-native', () => ({
  toast: toastMock,
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
  Alert: alertMock,
  AppState: { addEventListener: vi.fn() },
  Linking: linkingMock,
  Platform: { OS: 'ios' },
}));

const mockController = vi.hoisted(() => {
  type Subscriber = (snapshot: VoiceInputControllerSnapshot) => void;
  const subscribers = new Set<Subscriber>();
  let snapshot: VoiceInputControllerSnapshot = {
    availability: 'available',
    owner: null,
    status: 'idle',
  };

  return {
    abort: vi.fn<(owner?: string) => Promise<boolean>>().mockResolvedValue(true),
    getSnapshot: vi.fn<() => VoiceInputControllerSnapshot>(() => snapshot),
    setSnapshot(next: VoiceInputControllerSnapshot): void {
      snapshot = next;
      for (const subscriber of subscribers) {
        subscriber(next);
      }
    },
    start: vi.fn<(options: VoiceInputStartOptions) => Promise<boolean>>().mockResolvedValue(true),
    stop: vi.fn<(owner: string) => Promise<boolean>>().mockResolvedValue(true),
    subscribe: vi.fn<(listener: Subscriber) => () => void>(listener => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }),
    supportsOnDevice: vi.fn<() => boolean>(() => true),
  };
});

const voiceNetworkConsentMock = vi.hoisted(() => ({
  readVoiceNetworkConsent: vi.fn<(userId: string) => Promise<'granted' | 'declined' | 'unset'>>(),
  writeVoiceNetworkConsent:
    vi.fn<(userId: string, value: 'granted' | 'declined') => Promise<void>>(),
}));

vi.mock('./native-voice-input', () => ({
  voiceInputController: mockController,
}));

vi.mock('./voice-network-consent', () => voiceNetworkConsentMock);

type ActionHarness = {
  actions: {
    abort: () => Promise<boolean>;
    settleBeforeSubmit: () => Promise<boolean>;
    toggle: () => Promise<void>;
  };
  disabled: ReturnType<typeof vi.fn>;
  draft: ReturnType<typeof vi.fn>;
  onDraftChange: ReturnType<typeof vi.fn>;
  owner: string;
};

function buildActions(
  overrides: { disabled?: boolean; draft?: string; owner?: string; userId?: string } = {}
): ActionHarness {
  const owner = overrides.owner ?? 'owner-A';
  const draft = vi.fn<() => string>(() => overrides.draft ?? 'draft text');
  const onDraftChange = vi.fn<(nextDraft: string) => void>();
  const disabled = vi.fn<() => boolean>(() => overrides.disabled ?? false);
  const userId = vi.fn<() => string | undefined>(() => overrides.userId);

  const actions = createVoiceInputActions({
    controller: mockController,
    getDisabled: disabled,
    getDraft: draft,
    getOnDraftChange: () => onDraftChange,
    getOwner: () => owner,
    getUserId: userId,
  });

  return { actions, disabled, draft, onDraftChange, owner };
}

function idleSnapshot(): VoiceInputControllerSnapshot {
  return { availability: 'available', owner: null, status: 'idle' };
}

function activeSnapshot(
  owner: string,
  status: VoiceInputControllerSnapshot['status']
): VoiceInputControllerSnapshot {
  return { availability: 'available', owner, status };
}

describe('useVoiceInput integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockController.setSnapshot(idleSnapshot());
    mockController.supportsOnDevice.mockReturnValue(true);
    voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-US' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['en-US', 'nl-NL'],
      installedLocales: ['en-US'],
    });
    __resetVoiceInputLanguageTagCacheForTests();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
  });

  describe('createVoiceInputActions', () => {
    describe('settleBeforeSubmit', () => {
      it('delegates stop(owner) when the public snapshot is idle so a pending start is cancelled', async () => {
        const { actions } = buildActions();
        mockController.setSnapshot(idleSnapshot());
        mockController.stop.mockResolvedValueOnce(true);

        const result = await actions.settleBeforeSubmit();

        expect(result).toBe(true);
        expect(mockController.stop).toHaveBeenCalledWith(expect.any(String));
      });

      it('delegates stop(owner) and returns the controllers result when this owner is active', async () => {
        const { actions, owner } = buildActions();
        mockController.setSnapshot(activeSnapshot(owner, 'listening'));
        mockController.stop.mockResolvedValueOnce(true);

        const result = await actions.settleBeforeSubmit();

        expect(mockController.stop).toHaveBeenCalledWith(owner);
        expect(result).toBe(true);
      });
    });

    describe('toggle', () => {
      it('starts when idle, using the app language and passing draft/feedback callbacks', async () => {
        const { actions, onDraftChange, owner } = buildActions({ draft: 'hello' });
        mockController.setSnapshot(idleSnapshot());
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'nl-NL' }]);

        await actions.toggle();

        expect(mockController.start).toHaveBeenCalledTimes(1);
        const startOptions = mockController.start.mock.calls[0]?.[0];
        if (!startOptions) {
          throw new Error('controller.start was not called');
        }
        expect(startOptions.baseDraft).toBe('hello');
        expect(startOptions.languageTag).toBe('en-US');
        expect(startOptions.owner).toBe(owner);
        expect(startOptions.onDraftChange).toBe(onDraftChange);
        expect(startOptions.onFeedback).toBe(showFeedback);
      });

      it('resolves an en-DE device locale to en-US when the supported list contains en-AU and en-US', async () => {
        const { actions } = buildActions();
        mockController.setSnapshot(idleSnapshot());
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-DE' }]);
        getSupportedLocalesMock.mockResolvedValue({
          locales: ['en-AU', 'en-US'],
          installedLocales: ['en-US'],
        });

        await actions.toggle();

        const startOptions = mockController.start.mock.calls[0]?.[0];
        if (!startOptions) {
          throw new Error('controller.start was not called');
        }
        expect(startOptions.languageTag).toBe('en-US');
      });

      it('emits a medium haptic and stops when already listening', async () => {
        const { actions, owner } = buildActions();
        mockController.setSnapshot(activeSnapshot(owner, 'listening'));

        await actions.toggle();

        expect(hapticsMock.impactAsync).toHaveBeenCalledWith('medium');
        expect(mockController.stop).toHaveBeenCalledWith(owner);
      });

      it('does nothing while starting or stopping', async () => {
        const { actions, owner } = buildActions();
        mockController.setSnapshot(activeSnapshot(owner, 'starting'));

        await actions.toggle();

        expect(hapticsMock.impactAsync).not.toHaveBeenCalled();
        expect(mockController.stop).not.toHaveBeenCalled();
        expect(mockController.start).not.toHaveBeenCalled();
      });

      it('does nothing when disabled', async () => {
        const { actions } = buildActions({ disabled: true });
        mockController.setSnapshot(idleSnapshot());

        await actions.toggle();

        expect(mockController.start).not.toHaveBeenCalled();
      });

      it('starts with on-device recognition when on-device is supported regardless of consent', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('declined');

        await actions.toggle();

        expect(mockController.start).toHaveBeenCalledTimes(1);
        expect(mockController.start.mock.calls[0]?.[0]?.requiresOnDeviceRecognition).toBe(true);
        expect(alertMock.alert).not.toHaveBeenCalled();
        expect(toastMock.error).not.toHaveBeenCalled();
      });

      it('starts with network recognition when on-device is unsupported and consent is granted', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(false);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('granted');

        await actions.toggle();

        expect(mockController.start).toHaveBeenCalledTimes(1);
        expect(mockController.start.mock.calls[0]?.[0]?.requiresOnDeviceRecognition).toBe(false);
      });

      it('shows a toast and does not start when consent is declined', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(false);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('declined');

        await actions.toggle();

        expect(mockController.start).not.toHaveBeenCalled();
        expect(toastMock.error).toHaveBeenCalledWith(
          'Speech stays off until you allow online transcription.'
        );
        expect(alertMock.alert).not.toHaveBeenCalled();
      });

      it('raises the disclosure and does not start when consent is unset', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(false);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');

        await actions.toggle();

        expect(mockController.start).not.toHaveBeenCalled();
        expect(alertMock.alert).toHaveBeenCalledTimes(1);
        expect(alertMock.alert).toHaveBeenCalledWith(
          'Speech is processed online',
          expect.stringContaining('This device cannot transcribe offline'),
          expect.any(Array)
        );
        expect(toastMock.error).not.toHaveBeenCalled();
      });

      it('persists granted and starts when the disclosure Allow action is pressed', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(false);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');
        voiceNetworkConsentMock.writeVoiceNetworkConsent.mockResolvedValue(undefined);

        await actions.toggle();

        const buttons = alertMock.alert.mock.calls[0]?.[2] as
          | { text: string; onPress?: () => void }[]
          | undefined;
        const allow = buttons?.find(button => button.text === 'Allow');
        allow?.onPress?.();
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });

        expect(voiceNetworkConsentMock.writeVoiceNetworkConsent).toHaveBeenCalledWith(
          'user-1',
          'granted'
        );
        expect(mockController.start).toHaveBeenCalledTimes(1);
        expect(mockController.start.mock.calls[0]?.[0]?.requiresOnDeviceRecognition).toBe(false);
      });

      it('persists declined without starting when the disclosure Not now action is pressed', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(false);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');

        await actions.toggle();

        const buttons = alertMock.alert.mock.calls[0]?.[2] as
          | { text: string; onPress?: () => void }[]
          | undefined;
        const notNow = buttons?.find(button => button.text === 'Not now');
        notNow?.onPress?.();

        expect(voiceNetworkConsentMock.writeVoiceNetworkConsent).toHaveBeenCalledWith(
          'user-1',
          'declined'
        );
        expect(mockController.start).not.toHaveBeenCalled();
      });

      it('falls back to network recognition in the device language when German has no on-device model', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('granted');
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'de-DE' }]);
        getSupportedLocalesMock.mockResolvedValue({
          locales: ['de-DE', 'en-US'],
          installedLocales: ['en-US'],
        });
        await i18n.changeLanguage('de');

        await actions.toggle();

        const startOptions = mockController.start.mock.calls[0]?.[0];
        if (!startOptions) {
          throw new Error('controller.start was not called');
        }
        expect(startOptions.languageTag).toBe('de-DE');
        expect(startOptions.requiresOnDeviceRecognition).toBe(false);
      });

      it('raises the network disclosure when German has no on-device model and consent is unset, then starts network on Allow', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('unset');
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'de-DE' }]);
        getSupportedLocalesMock.mockResolvedValue({
          locales: ['de-DE', 'en-US'],
          installedLocales: ['en-US'],
        });
        await i18n.changeLanguage('de');

        await actions.toggle();

        expect(mockController.start).not.toHaveBeenCalled();
        expect(alertMock.alert).toHaveBeenCalledWith(
          i18n.t('voiceInput.onlineTitle'),
          i18n.t('voiceInput.onlineMessage', { provider: 'Apple' }),
          expect.any(Array)
        );

        const buttons = alertMock.alert.mock.calls[0]?.[2] as
          | { text: string; onPress?: () => void }[]
          | undefined;
        const allow = buttons?.find(button => button.text === i18n.t('voiceInput.allow'));
        allow?.onPress?.();
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });

        expect(mockController.start).toHaveBeenCalledTimes(1);
        const startOptions = mockController.start.mock.calls[0]?.[0];
        expect(startOptions?.languageTag).toBe('de-DE');
        expect(startOptions?.requiresOnDeviceRecognition).toBe(false);
      });

      it('offers the offline model download when German has no on-device model and consent is declined', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('declined');
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'de-DE' }]);
        getSupportedLocalesMock.mockResolvedValue({
          locales: ['de-DE', 'en-US'],
          installedLocales: ['en-US'],
        });
        await i18n.changeLanguage('de');

        await actions.toggle();

        expect(mockController.start).not.toHaveBeenCalled();
        expect(toastMock.error).not.toHaveBeenCalled();
        expect(alertMock.alert).toHaveBeenCalledWith(
          i18n.t('voiceInput.languageNotInstalledTitle', { language: 'Deutsch' }),
          i18n.t('voiceInput.languageNotInstalledMessage', { language: 'Deutsch' }),
          expect.any(Array)
        );

        const buttons = alertMock.alert.mock.calls[0]?.[2] as
          | { text: string; onPress?: () => void }[]
          | undefined;
        const download = buttons?.find(
          button => button.text === i18n.t('voiceInput.downloadOfflineModel')
        );
        download?.onPress?.();
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });

        expect(triggerOfflineModelDownloadMock).toHaveBeenCalledWith({ locale: 'de-DE' });
        expect(mockController.start).not.toHaveBeenCalled();
      });

      it('tells the user the download is queued when the system schedules the offline model download', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('declined');
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'de-DE' }]);
        getSupportedLocalesMock.mockResolvedValue({
          locales: ['de-DE', 'en-US'],
          installedLocales: ['en-US'],
        });
        await i18n.changeLanguage('de');
        triggerOfflineModelDownloadMock.mockResolvedValueOnce({
          status: 'download_scheduled',
          message: '',
        });

        await actions.toggle();

        const buttons = alertMock.alert.mock.calls[0]?.[2] as
          | { text: string; onPress?: () => void }[]
          | undefined;
        const download = buttons?.find(
          button => button.text === i18n.t('voiceInput.downloadOfflineModel')
        );
        download?.onPress?.();
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });

        expect(toastMock.success).toHaveBeenCalledWith(
          i18n.t('voiceInput.offlineModelDownloadScheduled')
        );
        expect(mockController.start).not.toHaveBeenCalled();
      });

      it('reaches on-device recognition on the next tap after a completed model download', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('declined');
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'de-DE' }]);
        getSupportedLocalesMock.mockResolvedValueOnce({
          locales: ['de-DE', 'en-US'],
          installedLocales: ['en-US'],
        });
        await i18n.changeLanguage('de');
        triggerOfflineModelDownloadMock.mockResolvedValueOnce({
          status: 'download_success',
          message: '',
        });

        await actions.toggle();

        const firstAlert = alertMock.alert.mock.calls[0]?.[2] as
          | { text: string; onPress?: () => void }[]
          | undefined;
        const download = firstAlert?.find(
          button => button.text === i18n.t('voiceInput.downloadOfflineModel')
        );
        download?.onPress?.();
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });

        // The model is installed now; the gate must re-query the service
        // instead of trusting the memoized pre-download list.
        getSupportedLocalesMock.mockResolvedValueOnce({
          locales: ['de-DE', 'en-US'],
          installedLocales: ['de-DE', 'en-US'],
        });
        alertMock.alert.mockClear();

        await actions.toggle();

        expect(alertMock.alert).not.toHaveBeenCalled();
        expect(mockController.start).toHaveBeenCalledTimes(1);
        expect(mockController.start.mock.calls[0]?.[0]?.requiresOnDeviceRecognition).toBe(true);
        expect(mockController.start.mock.calls[0]?.[0]?.languageTag).toBe('de-DE');
      });

      it('falls back to an actionable toast when the offline model download trigger fails', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('declined');
        localizationMock.getLocales.mockReturnValue([{ languageTag: 'de-DE' }]);
        getSupportedLocalesMock.mockResolvedValue({
          locales: ['de-DE', 'en-US'],
          installedLocales: ['en-US'],
        });
        await i18n.changeLanguage('de');
        triggerOfflineModelDownloadMock.mockRejectedValueOnce(new Error('download failed'));

        await actions.toggle();

        const buttons = alertMock.alert.mock.calls[0]?.[2] as
          | { text: string; onPress?: () => void }[]
          | undefined;
        const download = buttons?.find(
          button => button.text === i18n.t('voiceInput.downloadOfflineModel')
        );
        download?.onPress?.();
        await new Promise<void>(resolve => {
          setImmediate(resolve);
        });

        expect(toastMock.error).toHaveBeenCalledWith(i18n.t('voiceInput.unavailableLanguage'));
      });

      it('keeps on-device recognition when the service exposes no per-language data', async () => {
        const { actions } = buildActions({ userId: 'user-1' });
        mockController.setSnapshot(idleSnapshot());
        mockController.supportsOnDevice.mockReturnValue(true);
        voiceNetworkConsentMock.readVoiceNetworkConsent.mockResolvedValue('declined');
        getSupportedLocalesMock.mockRejectedValueOnce(new Error('not supported'));
        await i18n.changeLanguage('de');

        await actions.toggle();

        expect(mockController.start).toHaveBeenCalledTimes(1);
        expect(mockController.start.mock.calls[0]?.[0]?.requiresOnDeviceRecognition).toBe(true);
      });
    });

    describe('abort', () => {
      it('delegates abort(owner) to the controller', async () => {
        const { actions, owner } = buildActions();

        await actions.abort();

        expect(mockController.abort).toHaveBeenCalledWith(owner);
      });
    });
  });

  describe('shouldAbortVoiceInputForOwner', () => {
    it('returns true only when this owner is active and shouldAbortVoiceInput says true', () => {
      const owner = 'owner-A';
      const otherOwner = 'owner-B';

      expect(
        shouldAbortVoiceInputForOwner(activeSnapshot(owner, 'listening'), owner, {
          appState: 'active',
          disabled: false,
        })
      ).toBe(false);

      expect(
        shouldAbortVoiceInputForOwner(activeSnapshot(owner, 'listening'), owner, {
          appState: 'active',
          disabled: true,
        })
      ).toBe(true);

      expect(
        shouldAbortVoiceInputForOwner(activeSnapshot(owner, 'listening'), owner, {
          appState: 'background',
          disabled: false,
        })
      ).toBe(true);

      expect(
        shouldAbortVoiceInputForOwner(activeSnapshot(otherOwner, 'listening'), owner, {
          appState: 'background',
          disabled: false,
        })
      ).toBe(false);

      expect(
        shouldAbortVoiceInputForOwner(idleSnapshot(), owner, {
          appState: 'active',
          disabled: false,
        })
      ).toBe(false);
    });
  });
});
