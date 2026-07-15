import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type VoiceInputControllerSnapshot,
  type VoiceInputStartOptions,
} from './voice-input-controller';
import {
  createVoiceInputActions,
  shouldAbortVoiceInputForOwner,
  showFeedback,
} from './use-voice-input-actions';

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
}));

const localizationMock = vi.hoisted(() => ({
  getLocales: vi.fn<() => { languageTag: string }[]>(() => [{ languageTag: 'en-US' }]),
}));

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  impactAsync: hapticsMock.impactAsync,
}));

vi.mock('expo-localization', () => ({
  getLocales: localizationMock.getLocales,
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
  };
});

vi.mock('./native-voice-input', () => ({
  voiceInputController: mockController,
}));

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
  overrides: { disabled?: boolean; draft?: string; owner?: string } = {}
): ActionHarness {
  const owner = overrides.owner ?? 'owner-A';
  const draft = vi.fn<() => string>(() => overrides.draft ?? 'draft text');
  const onDraftChange = vi.fn<(nextDraft: string) => void>();
  const disabled = vi.fn<() => boolean>(() => overrides.disabled ?? false);

  const actions = createVoiceInputActions({
    controller: mockController,
    getDisabled: disabled,
    getDraft: draft,
    getOnDraftChange: () => onDraftChange,
    getOwner: () => owner,
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
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-US' }]);
  });

  afterEach(() => {
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
      it('starts when idle, using the latest draft and resolved language and passing draft/feedback callbacks', async () => {
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
        expect(startOptions.languageTag).toBe('nl-NL');
        expect(startOptions.owner).toBe(owner);
        expect(startOptions.onDraftChange).toBe(onDraftChange);
        expect(startOptions.onFeedback).toBe(showFeedback);
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
