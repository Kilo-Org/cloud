import {
  type ModelClientService,
  type ModelFacts,
  type ToolDefinition,
} from '@kilocode/harness-sdk';
import { type NativeModule, requireOptionalNativeModule } from 'expo';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { type LocalProvider, localTargetId } from './backend-target';
import { ggufModelProvider } from './gguf-models';
import {
  type NativeAvailability,
  type NativeModelBridge,
  nativeModelClient,
  type NativeModelEvent,
} from './native-model-client';
import { omittedTools } from './native-tool-schema';
import { offeredTools } from './offered-tools';

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
  /** Image parts reach `client` only when this is true for the model. */
  readonly supportsImages: (modelId: string) => boolean;
};

type SystemProvider = Exclude<LocalProvider, 'gguf'>;

/**
 * What one model can do with the tools the person enabled.
 *
 * `unknown` is the store's own answer before anyone has handed it the offered
 * tools; `none` is a model that takes every tool it is offered; `some` says
 * what this model cannot run. The two facts stay apart because they say
 * different things: a name in `tools` is a whole tool the model never sees,
 * while `option` says a tool it does receive is missing an optional argument.
 */
export type LocalModelToolUse =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'some';
      /** Whole tools the model never sees. Empty when only an option is affected. */
      readonly tools: readonly string[];
      /** One optional argument of a tool the model still receives cannot be set. */
      readonly option: boolean;
    };

/** What the settings sheet and the model picker show for one system provider. */
export type LocalModelStatus = {
  readonly provider: SystemProvider;
  readonly targetId: string;
  readonly nameKey: string;
  /** Undefined while the first check runs. */
  readonly availability: NativeAvailability | undefined;
  /** What this model can do with the enabled tools, once they are known. */
  readonly toolUse: LocalModelToolUse;
};

type SystemModelModule = InstanceType<
  typeof NativeModule<{ onModelEvent: (event: NativeModelEvent) => void }>
> &
  Required<Omit<NativeModelBridge, 'addListener' | 'resume'>> &
  // Only a module that runs the tool loop has it: Apple has it, Android does not.
  Pick<NativeModelBridge, 'resume'>;

/**
 * A provider that cannot answer its availability check is unavailable, not
 * missing. The reason says the check failed, so its copy never claims the
 * device cannot run the model.
 */
const UNANSWERED: NativeAvailability = {
  status: 'unavailable',
  reason: 'check_failed',
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
      ...(native.resume === undefined
        ? {}
        : {
            resume: async (id, results) => {
              await native.resume?.(id, results);
            },
          }),
      addListener: (eventName, listener) => native.addListener(eventName, listener),
    }),
    facts: () => systemFacts(known.get(provider)),
    // The module says whether it runs the tool loop. Until it answers, no tools are sent.
    supportsTools: () => known.get(provider)?.tools === true,
    supportsImages: () => known.get(provider)?.images === true,
  };
}

// Apple-only module. Older iOS versions load it and report `unsupported_os`.
const apple =
  Platform.OS === 'ios' ? requireOptionalNativeModule<SystemModelModule>('KiloAppleModel') : null;

// Android-only module. Devices without AICore or Gemini Nano report it unavailable.
const android =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<SystemModelModule>('KiloAndroidModel')
    : null;

const system: readonly {
  readonly provider: SystemProvider;
  readonly nameKey: string;
  readonly model: LocalModelProvider;
}[] = [
  ...(apple === null
    ? []
    : [
        {
          provider: 'apple' as const,
          nameKey: 'modelChat.localModels.apple',
          model: systemModelProvider('apple', apple),
        },
      ]),
  ...(android === null
    ? []
    : [
        {
          provider: 'android' as const,
          nameKey: 'modelChat.localModels.android',
          model: systemModelProvider('android', android),
        },
      ]),
];

function statusesOf(): readonly LocalModelStatus[] {
  return system.map(({ provider, nameKey }) => ({
    provider,
    targetId: localTargetId(provider),
    nameKey,
    availability: known.get(provider),
    toolUse: { kind: 'unknown' },
  }));
}

/**
 * What one model can do with the tools a chat offers.
 *
 * Only a check that has not answered is `unknown`: before the answer there is
 * nothing to say. Every settled answer is one of two facts. A model that runs
 * no tool loop runs none of the offered tools, whatever their schemas look
 * like, so every tool it is offered is left out and no option is. A model that
 * runs the loop names only what the converter leaves out: the tools it never
 * sees, and whether it sees any tool without one of its optional arguments.
 *
 * A tool name appears once, in the order the offered tools put it.
 */
export function toolUseOf(
  availability: NativeAvailability | undefined,
  offered: readonly ToolDefinition[]
): LocalModelToolUse {
  if (availability === undefined) {
    return { kind: 'unknown' };
  }
  if (availability.tools !== true) {
    return offered.length === 0
      ? { kind: 'none' }
      : {
          kind: 'some',
          tools: [...new Set(offered.map(tool => tool.name))],
          option: false,
        };
  }
  const tools: string[] = [];
  const toolNames = new Set<string>();
  let option = false;
  for (const omission of omittedTools(offeredTools(offered))) {
    if (omission.kind === 'tool') {
      if (!toolNames.has(omission.tool)) {
        toolNames.add(omission.tool);
        tools.push(omission.tool);
      }
    } else {
      option = true;
    }
  }
  return tools.length === 0 && !option ? { kind: 'none' } : { kind: 'some', tools, option };
}

statuses = statusesOf();

/** The provider for a decoded `local:` target, or undefined when this build has none. */
export function localModelProvider(provider: LocalProvider): LocalModelProvider | undefined {
  return provider === 'gguf'
    ? ggufModelProvider
    : system.find(one => one.provider === provider)?.model;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What a screen that offers no tools passes: one array, so the memo does not recompute. */
const NO_TOOLS: readonly ToolDefinition[] = [];

const currentStatuses = () => statuses;

/**
 * The registered providers' availability, and what each can do with the tools
 * the chat offers, checked again whenever a screen using it mounts.
 *
 * `offered` is the enabled tool set the caller would send. Its answer is
 * computed here rather than in the screen, so a status is the one place that
 * says which tools this model cannot run. Without it every status reads
 * `unknown`, which is what a screen that never offers tools needs.
 */
export function useLocalModels(
  offered: readonly ToolDefinition[] = NO_TOOLS
): readonly LocalModelStatus[] {
  useEffect(() => {
    for (const { model } of system) {
      void model.availability();
    }
  }, []);
  const stored = useSyncExternalStore(subscribe, currentStatuses, currentStatuses);
  return useMemo(
    () =>
      stored.map(status => ({
        ...status,
        toolUse: toolUseOf(status.availability, offered),
      })),
    [stored, offered]
  );
}
