import { AppState, type AppStateStatus } from 'react-native';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { type VoiceInputControllerSnapshot } from './voice-input-controller';
import { useVoiceInputLanguage } from './voice-input-language-preference';
import { voiceInputController } from './native-voice-input';
import { type VoiceInputFeedback, type VoiceInputStatus } from './voice-input-state';
import { resolveOwnerVoiceInputView } from './voice-input-view-state';
import {
  createVoiceInputActions,
  publishVoiceInputFeedback,
  readVoiceInputFeedback,
  runVoiceInputListeningFeedback,
  shouldAbortVoiceInputForOwner,
  subscribeVoiceInputFeedback,
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
  /** Last failure feedback, mirrored from `showFeedback`; null between sessions. */
  feedback: VoiceInputFeedback | null;
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
  const { userId } = useCurrentUserId();
  // The router of the root that renders this surface, not the module-level one
  // that the navigation container rebinds and unbinds across a recreation.
  const router = useRouter();

  const ownerRef = useRef<string | null>(null);
  ownerRef.current ??= nextOwnerId();
  const owner = ownerRef.current;

  const getDraftRef = useRef(getDraft);
  getDraftRef.current = getDraft;

  const getOnDraftChangeRef = useRef(onDraftChange);
  getOnDraftChangeRef.current = onDraftChange;

  const getDisabledRef = useRef(disabled);
  getDisabledRef.current = disabled;

  const getUserIdRef = useRef(userId);
  getUserIdRef.current = userId;

  // Read through a ref so an action created once in `actionsRef` always sees
  // the latest persisted language choice.
  const voiceLanguage = useVoiceInputLanguage();
  const voiceLanguageRef = useRef(voiceLanguage);
  voiceLanguageRef.current = voiceLanguage;

  // A feedback alert outlives the surface that raised it: its native dialog
  // stays on screen while the route, or the whole signed-in tree, is replaced
  // underneath it. A press then belongs to no owner, so it must not route into
  // whatever tree is in front now.
  const ownerAliveRef = useRef(true);
  useEffect(() => {
    ownerAliveRef.current = true;
    return () => {
      ownerAliveRef.current = false;
    };
  }, []);

  // Read through a ref for the same reason: the action created once below must
  // push through the router of the root that renders this surface now.
  const routerRef = useRef(router);
  routerRef.current = router;

  const openTranscriptionModelPicker = useCallback((): void => {
    if (!ownerAliveRef.current) {
      return;
    }
    routerRef.current.push('/(app)/transcription-model-picker' as Href);
  }, []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const feedback = useSyncExternalStore(
    subscribeVoiceInputFeedback,
    readVoiceInputFeedback,
    readVoiceInputFeedback
  );

  const actionsRef = useRef<VoiceInputActions | null>(null);
  actionsRef.current ??= createVoiceInputActions({
    controller: voiceInputController,
    getDisabled: () => getDisabledRef.current,
    getDraft: () => getDraftRef.current(),
    getLanguageTag: () => voiceLanguageRef.current,
    getOnDraftChange: () => getOnDraftChangeRef.current,
    getOwner: () => owner,
    getUserId: () => getUserIdRef.current,
    openTranscriptionModelPicker,
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
      // The recognizer answers availability live, so returning to the app is a
      // natural probe: the user may have installed, enabled or freed the speech
      // service while away.
      if (nextAppState === 'active') {
        voiceInputController.refreshAvailability();
      }
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
    // The controller captures availability once, when the module loads. A
    // surface that mounts later re-reads it, so a stale verdict never hides the
    // microphone on a recognizer that works.
    voiceInputController.refreshAvailability();
  }, []);

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
    // A new tap clears the previous failure so the surface never shows a stale
    // message while the next session is starting.
    publishVoiceInputFeedback(null);
    await actions.toggle();
  }, [actions]);

  return {
    abort,
    available: view.available,
    feedback,
    isActive: view.isActive,
    settleBeforeSubmit,
    status: view.status,
    toggle,
  };
}
