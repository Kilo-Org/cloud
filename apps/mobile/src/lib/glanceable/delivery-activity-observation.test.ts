import { describe, expect, it, vi } from 'vitest';

import { emptyActivityObservation, observeActivity } from './delivery-activity-observation';
import { GLANCEABLE_ACTIVITY_TOKEN_KIND, type Registration } from './delivery-registration-types';
import { type GlanceableActivity } from './sink-registry';

function createActivity(options: { tokens?: (string | null)[]; listenFails?: boolean }) {
  const listeners = new Set<(event: { activityId: string; pushToken: string }) => void>();
  const tokens = [...(options.tokens ?? [null])];
  const reads = vi.fn(() => Promise.resolve(tokens.shift() ?? null));
  const addPushTokenListener = vi.fn(
    (listener: (event: { activityId: string; pushToken: string }) => void) => {
      if (options.listenFails === true) {
        throw new Error('push-token listener unsupported');
      }
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    }
  );
  const instance: GlanceableActivity = { getPushToken: reads, addPushTokenListener };
  return { instance, reads, addPushTokenListener, listeners };
}

function createTarget(): Registration {
  return {
    organizationId: null,
    userId: null,
    kind: GLANCEABLE_ACTIVITY_TOKEN_KIND,
    epoch: 1,
    authEpoch: 0,
    token: null,
    registeredToken: null,
    tokens: new Set<string>(),
  };
}

describe('observeActivity', () => {
  it('leaves the card unobserved when the push-token listener throws, so a later observe binds it', async () => {
    const observation = emptyActivityObservation(new Set<string>());
    const target = createTarget();
    const registered: string[] = [];
    const registerToken = (_registration: Registration, token: string): Promise<void> => {
      registered.push(token);
      return Promise.resolve();
    };
    const failing = createActivity({ tokens: ['first-token'], listenFails: true });

    await observeActivity({
      observation,
      target,
      instance: failing.instance,
      onSuperseded: () => undefined,
      registerToken,
    });

    expect(observation.binding).toBeNull();
    expect(registered).toEqual([]);

    const healthy = createActivity({ tokens: ['second-token'] });
    await observeActivity({
      observation,
      target,
      instance: healthy.instance,
      onSuperseded: () => undefined,
      registerToken,
    });

    expect(observation.binding?.instance).toBe(healthy.instance);
    expect(healthy.listeners.size).toBe(1);
    expect(registered).toEqual(['second-token']);
  });

  it('re-reads the token on a repeated observe after a failed first read', async () => {
    const observation = emptyActivityObservation(new Set<string>());
    const target = createTarget();
    const registered: string[] = [];
    const registerToken = (_registration: Registration, token: string): Promise<void> => {
      registered.push(token);
      return Promise.resolve();
    };
    let reads = 0;
    const listeners = new Set<(event: { activityId: string; pushToken: string }) => void>();
    const instance: GlanceableActivity = {
      getPushToken: () => {
        reads += 1;
        if (reads === 1) {
          return Promise.reject(new Error('native token read failed'));
        }
        return Promise.resolve('late-token');
      },
      addPushTokenListener: listener => {
        listeners.add(listener);
        return {
          remove: () => {
            listeners.delete(listener);
          },
        };
      },
    };

    await observeActivity({
      observation,
      target,
      instance,
      onSuperseded: () => undefined,
      registerToken,
    });
    expect(registered).toEqual([]);

    await observeActivity({
      observation,
      target,
      instance,
      onSuperseded: () => undefined,
      registerToken,
    });

    expect(reads).toBe(2);
    expect(registered).toEqual(['late-token']);
  });

  it('binds the same card again after its listener creation failed once', async () => {
    const observation = emptyActivityObservation(new Set<string>());
    const target = createTarget();
    const registered: string[] = [];
    const registerToken = (_registration: Registration, token: string): Promise<void> => {
      registered.push(token);
      return Promise.resolve();
    };
    const listeners = new Set<(event: { activityId: string; pushToken: string }) => void>();
    let attempts = 0;
    const instance: GlanceableActivity = {
      getPushToken: () => Promise.resolve('card-token'),
      addPushTokenListener: listener => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('push-token listener unsupported');
        }
        listeners.add(listener);
        return {
          remove: () => {
            listeners.delete(listener);
          },
        };
      },
    };

    // The first observe leaves the card unobserved: nothing is registered and no
    // listener exists to feed it.
    await observeActivity({
      observation,
      target,
      instance,
      onSuperseded: () => undefined,
      registerToken,
    });
    expect(observation.binding).toBeNull();
    expect(listeners.size).toBe(0);
    expect(registered).toEqual([]);

    // The same card, observed again, must bind: no path back to it for the rest of
    // the process is the defect.
    await observeActivity({
      observation,
      target,
      instance,
      onSuperseded: () => undefined,
      registerToken,
    });

    expect(observation.binding?.instance).toBe(instance);
    expect(listeners.size).toBe(1);
    expect(registered).toEqual(['card-token']);
  });
});
