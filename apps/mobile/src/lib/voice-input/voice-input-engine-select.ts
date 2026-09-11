import { type VoiceInputNative, type VoiceInputNativeEvent } from './voice-input-controller';
import { type VoiceInputEngineName } from './voice-input-engine-mode';

/**
 * Compose the OS recogniser and the gateway transcription engine behind the
 * single `VoiceInputNative` the controller consumes, routing every call to
 * the engine the user chose. The choice is read at `start()`; there is no
 * fallback, so exactly one engine owns a session for its whole life and the
 * other engine receives no call of any kind.
 */
export function createSelectingVoiceInputNative(
  engines: Record<VoiceInputEngineName, VoiceInputNative>,
  getEngine: () => VoiceInputEngineName
): VoiceInputNative {
  type AnyVoiceInputListener = (event: VoiceInputNativeEvent[keyof VoiceInputNativeEvent]) => void;
  const listeners = new Map<keyof VoiceInputNativeEvent, Set<AnyVoiceInputListener>>();

  const forward = <K extends keyof VoiceInputNativeEvent>(
    event: K,
    payload: VoiceInputNativeEvent[K]
  ): void => {
    const set = listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of set) {
      listener(payload);
    }
  };

  /** The engine owning the current session, or null between sessions. */
  let active: VoiceInputEngineName | null = null;
  let engineSubscriptions: { remove(): void }[] = [];

  const closeSession = (): void => {
    active = null;
    for (const subscription of engineSubscriptions) {
      subscription.remove();
    }
    engineSubscriptions = [];
  };

  /** Attach to one engine for the session; events from the idle engine are dropped. */
  const subscribeEngine = (name: VoiceInputEngineName): void => {
    const engine = engines[name];
    engineSubscriptions.push(
      engine.addListener('start', () => {
        if (active === name) {
          forward('start', null);
        }
      }),
      engine.addListener('transcribing', () => {
        if (active === name) {
          forward('transcribing', null);
        }
      }),
      engine.addListener('result', event => {
        if (active === name) {
          forward('result', event);
        }
      }),
      engine.addListener('nomatch', () => {
        if (active === name) {
          forward('nomatch', null);
        }
      }),
      engine.addListener('error', event => {
        if (active === name) {
          forward('error', event);
        }
      }),
      engine.addListener('end', () => {
        if (active !== name) {
          return;
        }
        forward('end', null);
        closeSession();
      })
    );
  };

  return {
    addListener(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const boxed = listener as AnyVoiceInputListener;
      set.add(boxed);
      return {
        remove: (): void => {
          listeners.get(event)?.delete(boxed);
        },
      };
    },
    getPermissions: async () => {
      const permission = await engines[getEngine()].getPermissions();
      return permission;
    },
    requestPermissions: async () => {
      const permission = await engines[getEngine()].requestPermissions();
      return permission;
    },
    isRecognitionAvailable: () => engines[getEngine()].isRecognitionAvailable(),
    supportsContinuousRecognition: () => engines[getEngine()].supportsContinuousRecognition(),
    supportsOnDevice: () => engines[getEngine()].supportsOnDevice(),
    start: options => {
      closeSession();
      const name = getEngine();
      active = name;
      subscribeEngine(name);
      try {
        engines[name].start(options);
      } catch (error) {
        closeSession();
        throw error;
      }
    },
    stop: () => {
      if (active === null) {
        return;
      }
      engines[active].stop();
    },
    abort: () => {
      if (active === null) {
        return;
      }
      engines[active].abort();
    },
  };
}
