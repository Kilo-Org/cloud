import { describe, expect, it, vi } from 'vitest';

import {
  createVoiceInputController,
  type VoiceInputControllerSnapshot,
} from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  makeStartOptions,
  recordFeedback,
  type VoiceInputNativeHarness,
} from './voice-input-controller-test-helpers';

describe('createVoiceInputController - start and permission', () => {
  const build = (overrides: Partial<VoiceInputNativeHarness['controls']> = {}) => {
    const harness = createVoiceInputNativeHarness(overrides);
    const controller = createVoiceInputController(harness.native);
    return { harness, controller };
  };

  it('reports availability from isRecognitionAvailable()', () => {
    const { controller } = build();
    expect(controller.getSnapshot().availability).toBe('available');

    const unavailableHarness = createVoiceInputNativeHarness({ isAvailable: false });
    const unavailableController = createVoiceInputController(unavailableHarness.native);
    expect(unavailableController.getSnapshot().availability).toBe('unavailable');
  });

  it('starts idle with no owner', () => {
    const { controller } = build();
    expect(controller.getSnapshot().owner).toBeNull();
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('registers one permanent native listener for each lifecycle event', () => {
    const { harness } = build();
    expect(harness.listenerCount('start')).toBe(1);
    expect(harness.listenerCount('result')).toBe(1);
    expect(harness.listenerCount('nomatch')).toBe(1);
    expect(harness.listenerCount('error')).toBe(1);
    expect(harness.listenerCount('end')).toBe(1);
  });

  describe('availability gating', () => {
    it('returns false, reports unavailable feedback, and skips permission/start when unavailable', async () => {
      const { harness, controller } = build({ isAvailable: false });
      const fb = recordFeedback();

      const result = await controller.start({
        baseDraft: '',
        languageTag: 'en-US',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(result).toBe(false);
      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'unavailable',
          message: "Voice input isn't available on this device.",
          retryable: false,
        },
      ]);
      expect(harness.mocks.getPermissions).not.toHaveBeenCalled();
      expect(harness.mocks.requestPermissions).not.toHaveBeenCalled();
      expect(harness.mocks.start).not.toHaveBeenCalled();
      expect(controller.getSnapshot().status).toBe('idle');
    });
  });

  describe('permission flow', () => {
    it('requests permission only when not granted and canAskAgain', async () => {
      const { harness, controller } = build({
        permissionGranted: false,
        permissionCanAskAgain: true,
      });
      await controller.start(makeStartOptions());
      expect(harness.mocks.getPermissions).toHaveBeenCalledTimes(1);
      expect(harness.mocks.requestPermissions).toHaveBeenCalledTimes(1);
    });

    it('does not request permission when already granted', async () => {
      const { harness, controller } = build({ permissionGranted: true });
      await controller.start(makeStartOptions());
      expect(harness.mocks.getPermissions).toHaveBeenCalledTimes(1);
      expect(harness.mocks.requestPermissions).not.toHaveBeenCalled();
    });

    it('does not request permission when canAskAgain is false and reports open-settings', async () => {
      const { harness, controller } = build({
        permissionGranted: false,
        permissionCanAskAgain: false,
      });
      const fb = recordFeedback();

      const result = await controller.start({
        baseDraft: '',
        languageTag: 'en-US',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(result).toBe(false);
      expect(harness.mocks.requestPermissions).not.toHaveBeenCalled();
      expect(fb.feedback).toEqual([
        {
          action: 'open-settings',
          availability: 'available',
          message: 'Microphone access is off. Enable it in Settings to use voice input.',
          retryable: false,
        },
      ]);
    });

    it('reports retryable feedback when request returns a requestable denial', async () => {
      const { harness, controller } = build();
      const permission = {
        granted: false,
        canAskAgain: true,
        restricted: false,
      };
      harness.mocks.getPermissions = vi.fn(async () => {
        const result = await Promise.resolve(permission);
        return result;
      });
      harness.mocks.requestPermissions = vi.fn(async () => {
        const result = await Promise.resolve(permission);
        return result;
      });
      const fb = recordFeedback();

      const result = await controller.start({
        baseDraft: '',
        languageTag: 'en-US',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(result).toBe(false);
      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Microphone access is required for voice input.',
          retryable: true,
        },
      ]);
    });

    it('reports restricted feedback when the device reports a content restriction', async () => {
      const { controller } = build({
        permissionGranted: false,
        permissionCanAskAgain: false,
        permissionRestricted: true,
      });
      const fb = recordFeedback();

      const result = await controller.start({
        baseDraft: '',
        languageTag: 'en-US',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(result).toBe(false);
      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input is restricted on this device.',
          retryable: false,
        },
      ]);
    });

    it('reports client feedback and returns false when getPermissions rejects', async () => {
      const { harness, controller } = build();
      harness.mocks.getPermissions = vi.fn(async () => {
        await Promise.resolve();
        throw new Error('boom');
      });
      const fb = recordFeedback();

      const result = await controller.start({
        baseDraft: '',
        languageTag: 'en-US',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(result).toBe(false);
      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input stopped. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
      expect(harness.mocks.start).not.toHaveBeenCalled();
    });

    it('reports client feedback and returns false when requestPermissions rejects', async () => {
      const { harness, controller } = build({
        permissionGranted: false,
        permissionCanAskAgain: true,
      });
      harness.mocks.getPermissions = vi.fn(async () => {
        const result = await Promise.resolve({
          granted: false,
          canAskAgain: true,
          restricted: false,
        });
        return result;
      });
      harness.mocks.requestPermissions = vi.fn(async () => {
        await Promise.resolve();
        throw new Error('boom');
      });
      const fb = recordFeedback();

      const result = await controller.start({
        baseDraft: '',
        languageTag: 'en-US',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(result).toBe(false);
      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input stopped. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
      expect(harness.mocks.start).not.toHaveBeenCalled();
    });
  });

  describe('native.start invocation', () => {
    it('sets owner and starting, notifies subscribers, then calls native.start with the documented options', async () => {
      const { harness, controller } = build();
      const observed: VoiceInputControllerSnapshot[] = [];
      controller.subscribe((snap): void => {
        observed.push(snap);
      });
      const fb = recordFeedback();

      const started = await controller.start({
        baseDraft: 'hello ',
        languageTag: 'fr-FR',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(started).toBe(true);
      expect(harness.mocks.start).toHaveBeenCalledTimes(1);
      expect(harness.mocks.start).toHaveBeenCalledWith({
        continuous: true,
        interimResults: true,
        lang: 'fr-FR',
        maxAlternatives: 1,
      });

      const startingSnap = observed.find(snap => snap.status === 'starting');
      expect(startingSnap).toBeDefined();
      if (startingSnap) {
        expect(startingSnap.owner).toBe('A');
        expect(startingSnap.availability).toBe('available');
      }
    });

    it('passes continuous:false when supportsContinuousRecognition returns false', async () => {
      const { harness, controller } = build({ supportsContinuous: false });
      await controller.start(makeStartOptions());
      expect(harness.mocks.start).toHaveBeenCalledWith({
        continuous: false,
        interimResults: true,
        lang: 'en-US',
        maxAlternatives: 1,
      });
    });

    it('catches a synchronous native.start throw, reports client once, terminalizes, and returns false', async () => {
      const { harness, controller } = build();
      harness.mocks.start = vi.fn((): void => {
        throw new Error('boom');
      });
      const fb = recordFeedback();

      const result = await controller.start({
        baseDraft: '',
        languageTag: 'en-US',
        onDraftChange: (): void => undefined,
        onFeedback: fb.onFeedback,
        owner: 'A',
      });

      expect(result).toBe(false);
      expect(fb.feedback).toEqual([
        {
          action: 'none',
          availability: 'available',
          message: 'Voice input stopped. Tap the microphone to try again.',
          retryable: true,
        },
      ]);
      expect(controller.getSnapshot().owner).toBeNull();
      expect(controller.getSnapshot().status).toBe('idle');
    });
  });
});
