import { type LocalAccessPrivacySnapshot } from '../../../src/lib/local-access-privacy';

type NativeTestState = {
  available: boolean;
  nativeFailure: boolean;
  secure: boolean;
  captureFailure: boolean;
  captureWait: Promise<undefined> | undefined;
  captureEvents: string[];
  snapshot: {
    -readonly [Key in keyof LocalAccessPrivacySnapshot]: LocalAccessPrivacySnapshot[Key];
  };
  delivered: string[];
  queue: (() => void)[];
  listeners: Map<string, (event: never) => void>;
};

/** Deterministic native queue adapter. The Swift/Java suites execute the actual visibility reducers. */
export function createPrivacyNativeTestModule(adapter: NativeTestState) {
  if (!adapter.available) {
    throw new Error('Missing native privacy');
  }
  return {
    arm: () => {
      adapter.snapshot.armed = true;
      adapter.snapshot.covered = true;
      adapter.snapshot.generation += 1;
    },
    disarm: () => {
      adapter.snapshot.armed = false;
      adapter.snapshot.covered = false;
      adapter.snapshot.generation += 1;
    },
    cover: () => {
      adapter.snapshot.covered = adapter.snapshot.armed;
      adapter.snapshot.generation += 1;
    },
    getSnapshot: () => ({ ...adapter.snapshot }),
    publishVisibility: (generation: number) => {
      if (generation !== adapter.snapshot.generation || !adapter.snapshot.foreground) {
        return false;
      }
      adapter.snapshot.covered = false;
      return true;
    },
    isForegroundAllowed: () => {
      if (adapter.nativeFailure) {
        throw new Error('Native failure');
      }
      return adapter.snapshot.foreground && !adapter.snapshot.covered;
    },
    announce: async (message: string, generation: number, gate: boolean) => {
      const result = await new Promise<boolean>(resolve => {
        adapter.queue.push(() => {
          const allowed =
            generation === adapter.snapshot.generation &&
            (!adapter.snapshot.armed ||
              (adapter.snapshot.foreground && (!adapter.snapshot.covered || gate)));
          if (allowed) {
            adapter.delivered.push(message);
          }
          resolve(allowed);
        });
      });
      return result;
    },
    addListener: (name: string, listener: (event: never) => void) => {
      adapter.listeners.set(name, listener);
      return { remove: () => adapter.listeners.delete(name) };
    },
  };
}

/** Fake only the capture native boundary; Expo retains ownership of its real key set. */
export function createCaptureNativeTestModule(adapter: NativeTestState) {
  return {
    UnavailabilityError: Error,
    requireNativeModule: () => ({
      preventScreenCapture: async () => {
        adapter.captureEvents.push('prevent');
        if (adapter.captureWait) {
          await adapter.captureWait;
        }
        if (adapter.captureFailure) {
          throw new Error('Capture unavailable');
        }
        adapter.secure = true;
      },
      allowScreenCapture: async () => {
        adapter.captureEvents.push('allow');
        await Promise.resolve();
        adapter.secure = false;
      },
    }),
  };
}
