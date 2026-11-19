import { beforeEach, describe, expect, it, vi } from 'vitest';

import { finishHandlingNotificationResponse } from './notification-response-completion';

const mocks = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: mocks.requireOptionalNativeModule,
}));

beforeEach(() => {
  mocks.requireOptionalNativeModule.mockReset();
});

describe('finishHandlingNotificationResponse', () => {
  it('reports the key to the patched iOS emitter module', () => {
    const finish = vi.fn<(key: string) => void>();
    mocks.requireOptionalNativeModule.mockReturnValue({
      finishHandlingNotificationResponse: finish,
    });

    finishHandlingNotificationResponse('needs-input:ses_1:approve');

    expect(mocks.requireOptionalNativeModule).toHaveBeenCalledWith('ExpoNotificationsEmitter');
    expect(finish).toHaveBeenCalledExactlyOnceWith('needs-input:ses_1:approve');
  });

  it('does nothing with an emitter module that lacks the function (Android, unpatched iOS)', () => {
    mocks.requireOptionalNativeModule.mockReturnValue({});

    expect(() => {
      finishHandlingNotificationResponse('needs-input:ses_1:approve');
    }).not.toThrow();
  });

  it('does nothing without the emitter module', () => {
    mocks.requireOptionalNativeModule.mockReturnValue(null);

    expect(() => {
      finishHandlingNotificationResponse('needs-input:ses_1:approve');
    }).not.toThrow();
  });

  it('swallows a throwing native call, which the native timeout still ends', () => {
    mocks.requireOptionalNativeModule.mockReturnValue({
      finishHandlingNotificationResponse: () => {
        throw new Error('bridge gone');
      },
    });

    expect(() => {
      finishHandlingNotificationResponse('needs-input:ses_1:approve');
    }).not.toThrow();
  });
});
