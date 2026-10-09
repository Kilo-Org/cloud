import { type ModelClientService, type ModelFacts } from '@kilocode/harness-sdk';
import { type NativeModule, requireOptionalNativeModule } from 'expo';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { type LocalProvider, localTargetId } from './backend-target';
import {
  type NativeAvailability,
  type NativeModelBridge,
  nativeModelClient,
  type NativeModelEvent,
} from './native-model-client';

/** One on-device provider. The harness still owns the conversation; this supplies inference. */
export type LocalModelProvider = {
  /**
   * Asks the provider now and remembers the answer for `facts` and the settings
   * sheet. A failed check resolves as unavailable rather than rejecting.
   */
  readonly availability: () => Promise<NativeAvailability>;
  readonly client: ModelClientService;
  /** Limits from the last availability answer. Empty until one arrives. */
  readonly facts: (modelId: string) => ModelFacts;
  readonly supportsTools: (modelId: string) => boolean;
};

type SystemProvider = Exclude<LocalProvider, 'gguf'>;

/** What the settings sheet and the model picker show for one system provider. */
export type LocalModelStatus = {
  readonly provider: SystemProvider;
  readonly targetId: string;
  readonly nameKey: string;
  /** Undefined while the first check runs. */
  readonly availability: NativeAvailability | undefined;
};

type SystemModelModule = InstanceType<
  typeof NativeModule<{ onModelEvent: (event: NativeModelEvent) => void }>
> &
  Required<Omit<NativeModelBridge, 'addListener'>>;

/** A provider that cannot answer its availability check is unavailable, not missing. */
const UNANSWERED: NativeAvailability = {
  status: 'unavailable',
  reason: 'model_unavailable',
  modelId: '',
  contextWindow: 0,
  maxOutputTokens: 0,
  systemInstructions: false,
};

const known = new Map<SystemProvider, NativeAvailability>();
let statuses: readonly LocalModelStatus[] = [];
const listeners = new Set<() => void>();

/** No package transport speaks to these models; the router calls the client directly. */
function systemFacts(availability: NativeAvailability | undefined): ModelFacts {
  return {
    apiKinds: [],
    ...(availability === undefined || availability.contextWindow <= 0
      ? {}
      : { contextWindow: availability.contextWindow }),
    ...(availability === undefined || availability.maxOutputTokens <= 0
      ? {}
      : { maxOutputTokens: availability.maxOutputTokens }),
  };
}

function systemModelProvider(
  provider: SystemProvider,
  native: SystemModelModule
): LocalModelProvider {
  const availability = async () => {
    let answer = UNANSWERED;
    try {
      answer = await native.availability();
    } catch {
      // An unanswered check reads as unavailable, so a send fails explicitly.
    }
    known.set(provider, answer);
    statuses = statusesOf();
    for (const listener of listeners) {
      listener();
    }
    return answer;
  };
  return {
    availability,
    client: nativeModelClient({
      availability,
      generate: async request => {
        await native.generate(request);
      },
      cancel: async id => {
        await native.cancel(id);
      },
      countTokens: async request => {
        const count = await native.countTokens(request);
        return count;
      },
      addListener: (eventName, listener) => native.addListener(eventName, listener),
    }),
    facts: () => systemFacts(known.get(provider)),
    // System on-device models are text-only: no tool definitions are sent.
    supportsTools: () => false,
  };
}

// Apple-only module. Older iOS versions load it and report `unsupported_os`.
const apple =
  Platform.OS === 'ios' ? requireOptionalNativeModule<SystemModelModule>('KiloAppleModel') : null;

const system: readonly {
  readonly provider: SystemProvider;
  readonly nameKey: string;
  readonly model: LocalModelProvider;
}[] =
  apple === null
    ? []
    : [
        {
          provider: 'apple',
          nameKey: 'modelChat.localModels.apple',
          model: systemModelProvider('apple', apple),
        },
      ];

function statusesOf(): readonly LocalModelStatus[] {
  return system.map(({ provider, nameKey }) => ({
    provider,
    targetId: localTargetId(provider),
    nameKey,
    availability: known.get(provider),
  }));
}

statuses = statusesOf();

/** The provider for a decoded `local:` target, or undefined when this build has none. */
export function localModelProvider(provider: LocalProvider): LocalModelProvider | undefined {
  return system.find(one => one.provider === provider)?.model;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const currentStatuses = () => statuses;

/** The registered providers' availability, checked again whenever a screen using it mounts. */
export function useLocalModels(): readonly LocalModelStatus[] {
  useEffect(() => {
    for (const { model } of system) {
      void model.availability();
    }
  }, []);
  return useSyncExternalStore(subscribe, currentStatuses, currentStatuses);
}
