import { AppState, type AppStateStatus } from 'react-native';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { type VoiceInputControllerSnapshot } from './voice-input-controller';
import { voiceInputController } from './native-voice-input';
import { type VoiceInputStatus } from './voice-input-state';
import { resolveOwnerVoiceInputView } from './voice-input-view-state';
import {
  createVoiceInputActions,
  runVoiceInputListeningFeedback,
  shouldAbortVoiceInputForOwner,
  type VoiceInputActions,
} from './use-voice-input-actions';

type UseVoiceInputOptions = {
  disabled: boolean;
  getDraft: () => string;
  onDraftChange: (draft: string) => void;
};

type UseVoiceInputResult = {
  abort: () => Promise<boolean>;
  available: boolean;
  isActive: boolean;
  settleBeforeSubmit: () => Promise<boolean>;
  status: VoiceInputStatus;
  toggle: () => Promise<void>;
};

let ownerCounter = 0;

function nextOwnerId(): string {
  ownerCounter += 1;
  return `voice-input-owner-${ownerCounter}`;
}

function toLifecycleAppState(status: AppStateStatus): 'active' | 'background' | 'inactive' {
  if (status === 'active') {
    return 'active';
  }
  if (status === 'inactive') {
    return 'inactive';
  }
  return 'background';
}

const subscribe = (listener: () => void): (() => void) =>
  voiceInputController.subscribe(() => {
    listener();
  });

const getSnapshot = (): VoiceInputControllerSnapshot => voiceInputController.getSnapshot();

const getServerSnapshot = getSnapshot;

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { disabled, getDraft, onDraftChange } = options;

  const ownerRef = useRef<string | null>(null);
  ownerRef.current ??= nextOwnerId();
  const owner = ownerRef.current;

  const getDraftRef = useRef(getDraft);
  getDraftRef.current = getDraft;

  const getOnDraftChangeRef = useRef(onDraftChange);
  getOnDraftChangeRef.current = onDraftChange;

  const getDisabledRef = useRef(disabled);
  getDisabledRef.current = disabled;

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const actionsRef = useRef<VoiceInputActions | null>(null);
  actionsRef.current ??= createVoiceInputActions({
    controller: voiceInputController,
    getDisabled: () => getDisabledRef.current,
    getDraft: () => getDraftRef.current(),
    getOnDraftChange: () => getOnDraftChangeRef.current,
    getOwner: () => owner,
  });
  const actions = actionsRef.current;

  const view = resolveOwnerVoiceInputView(snapshot, owner);

  const previousOwnStatusRef = useRef<VoiceInputStatus | null>(null);
  useEffect(() => {
    const previousOwnStatus = previousOwnStatusRef.current;
    previousOwnStatusRef.current = view.status;
    runVoiceInputListeningFeedback(previousOwnStatus, view.status);
  }, [view.status]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const lifecycleInput = {
        appState: toLifecycleAppState(nextAppState),
        disabled: getDisabledRef.current,
      };
      const currentSnapshot = voiceInputController.getSnapshot();
      if (!shouldAbortVoiceInputForOwner(currentSnapshot, owner, lifecycleInput)) {
        return;
      }
      void actions.abort();
    });
    return () => {
      subscription.remove();
    };
  }, [owner, actions]);

  useEffect(
    () => () => {
      void actions.abort();
    },
    [actions]
  );

  useEffect(() => {
    const currentSnapshot = voiceInputController.getSnapshot();
    if (!shouldAbortVoiceInputForOwner(currentSnapshot, owner, { appState: 'active', disabled })) {
      return;
    }
    void actions.abort();
  }, [disabled, owner, actions]);

  const abort = useCallback(async () => {
    const result = await actions.abort();
    return result;
  }, [actions]);

  const settleBeforeSubmit = useCallback(async () => {
    const result = await actions.settleBeforeSubmit();
    return result;
  }, [actions]);

  const toggle = useCallback(async () => {
    await actions.toggle();
  }, [actions]);

  return {
    abort,
    available: view.available,
    isActive: view.isActive,
    settleBeforeSubmit,
    status: view.status,
    toggle,
  };
}
