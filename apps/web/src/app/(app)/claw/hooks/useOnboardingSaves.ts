'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  execPresetToConfig,
  type BotIdentity,
  type ClawMutations,
  type ExecPreset,
} from '../components/claw.types';

/**
 * Onboarding save operations.
 *
 * The setup wizard stores bot identity, exec preset, and channel tokens as soon
 * as an instance row exists. These are normal save mutations: the DO persists
 * the requested values immediately and replays any needed config to the machine
 * when the gateway is available.
 *
 * This hook keeps those saves alive outside `ProvisioningStep`, which may
 * unmount while the provisioning spinner is showing. Each mutation retries until
 * its durable write succeeds, and `ready` lets the provisioning screen wait for
 * the required saves before completing.
 */

export type OnboardingSaveFlags = {
  botIdentity: boolean;
  execPreset: boolean;
  channels: boolean;
};

type OnboardingSaveName = keyof OnboardingSaveFlags;

export type OnboardingSaveStatus = 'idle' | 'pending' | 'success' | 'error';

export type OnboardingSaveStatuses = Record<OnboardingSaveName, OnboardingSaveStatus>;

export type OnboardingSavePlan = {
  botIdentity?: BotIdentity;
  execPreset?: { security: string; ask: string };
  channels?: Record<string, string>;
};

export type OnboardingSavesState = {
  ready: boolean;
  pending: boolean;
  statuses: OnboardingSaveStatuses;
};

const SAVE_NAMES: readonly OnboardingSaveName[] = ['botIdentity', 'execPreset', 'channels'];
const ONBOARDING_SAVE_RETRY_MS = 2_000;

function createSaveFlags(): OnboardingSaveFlags {
  return { botIdentity: false, execPreset: false, channels: false };
}

function createSaveStatuses(): OnboardingSaveStatuses {
  return { botIdentity: 'idle', execPreset: 'idle', channels: 'idle' };
}

function hasChannelTokens(
  channelTokens: Record<string, string> | null
): channelTokens is Record<string, string> {
  return channelTokens !== null && Object.keys(channelTokens).length > 0;
}

export function getRequiredOnboardingSaves({
  hasInstance,
  botIdentity,
  selectedPreset,
  channelTokens,
}: {
  hasInstance: boolean;
  botIdentity: BotIdentity | null;
  selectedPreset: ExecPreset | null;
  channelTokens: Record<string, string> | null;
}): OnboardingSaveFlags {
  if (!hasInstance) return createSaveFlags();

  return {
    botIdentity: botIdentity !== null,
    execPreset: selectedPreset !== null && selectedPreset !== 'always-ask',
    channels: hasChannelTokens(channelTokens),
  };
}

export function areOnboardingSavesReady({
  hasInstance,
  botIdentity,
  selectedPreset,
  channelTokens,
  statuses,
}: {
  hasInstance: boolean;
  botIdentity: BotIdentity | null;
  selectedPreset: ExecPreset | null;
  channelTokens: Record<string, string> | null;
  statuses: OnboardingSaveStatuses;
}): boolean {
  if (!hasInstance) return false;

  const required = getRequiredOnboardingSaves({
    hasInstance,
    botIdentity,
    selectedPreset,
    channelTokens,
  });

  return SAVE_NAMES.every(name => !required[name] || statuses[name] === 'success');
}

/**
 * Pure decision logic: given the current onboarding inputs and save latches,
 * return the set of saves that should start now. A save is only included if
 * (a) the instance row exists, (b) its input is present, (c) it has not yet
 * succeeded in this onboarding session, and (d) it is not already in flight.
 *
 * `always-ask` is the gateway default, so we skip the exec preset save when the
 * user explicitly selects it -- no write needed.
 */
export function planOnboardingSaves({
  hasInstance,
  botIdentity,
  selectedPreset,
  channelTokens,
  completed,
  inFlight = createSaveFlags(),
}: {
  hasInstance: boolean;
  botIdentity: BotIdentity | null;
  selectedPreset: ExecPreset | null;
  channelTokens: Record<string, string> | null;
  completed: OnboardingSaveFlags;
  inFlight?: OnboardingSaveFlags;
}): OnboardingSavePlan {
  const plan: OnboardingSavePlan = {};
  if (!hasInstance) return plan;

  if (!completed.botIdentity && !inFlight.botIdentity && botIdentity) {
    plan.botIdentity = botIdentity;
  }
  if (
    !completed.execPreset &&
    !inFlight.execPreset &&
    selectedPreset &&
    selectedPreset !== 'always-ask'
  ) {
    plan.execPreset = execPresetToConfig(selectedPreset);
  }
  if (!completed.channels && !inFlight.channels && hasChannelTokens(channelTokens)) {
    plan.channels = channelTokens;
  }

  return plan;
}

export function useOnboardingSaves({
  hasInstance,
  botIdentity,
  selectedPreset,
  channelTokens,
  resetKey,
  mutations,
}: {
  hasInstance: boolean;
  botIdentity: BotIdentity | null;
  selectedPreset: ExecPreset | null;
  channelTokens: Record<string, string> | null;
  resetKey: string;
  mutations: ClawMutations;
}): OnboardingSavesState {
  const completedRef = useRef<OnboardingSaveFlags>(createSaveFlags());
  const inFlightRef = useRef<OnboardingSaveFlags>(createSaveFlags());
  const errorToastShownRef = useRef<OnboardingSaveFlags>(createSaveFlags());
  const retryTimersRef = useRef<Partial<Record<OnboardingSaveName, ReturnType<typeof setTimeout>>>>(
    {}
  );
  const activeResetKeyRef = useRef(resetKey);
  const [statuses, setStatuses] = useState<OnboardingSaveStatuses>(createSaveStatuses);
  const [retryTick, setRetryTick] = useState(0);

  const clearRetryTimer = useCallback((name: OnboardingSaveName) => {
    const timer = retryTimersRef.current[name];
    if (timer) {
      clearTimeout(timer);
      delete retryTimersRef.current[name];
    }
  }, []);

  const clearRetryTimers = useCallback(() => {
    for (const name of SAVE_NAMES) {
      clearRetryTimer(name);
    }
  }, [clearRetryTimer]);

  const setSaveStatus = useCallback((name: OnboardingSaveName, status: OnboardingSaveStatus) => {
    setStatuses(current => {
      if (current[name] === status) return current;
      return { ...current, [name]: status };
    });
  }, []);

  const scheduleRetry = useCallback(
    (name: OnboardingSaveName, requestResetKey: string) => {
      clearRetryTimer(name);
      retryTimersRef.current[name] = setTimeout(() => {
        if (activeResetKeyRef.current !== requestResetKey) return;
        setRetryTick(value => value + 1);
      }, ONBOARDING_SAVE_RETRY_MS);
    },
    [clearRetryTimer]
  );

  const markSaveSucceeded = useCallback(
    (name: OnboardingSaveName, requestResetKey: string) => {
      if (activeResetKeyRef.current !== requestResetKey) return;
      clearRetryTimer(name);
      completedRef.current[name] = true;
      errorToastShownRef.current[name] = false;
      setSaveStatus(name, 'success');
    },
    [clearRetryTimer, setSaveStatus]
  );

  const markSaveFailed = useCallback(
    (name: OnboardingSaveName, requestResetKey: string, err: { message: string }) => {
      if (activeResetKeyRef.current !== requestResetKey) return;
      if (!errorToastShownRef.current[name]) {
        toast.error(err.message);
        errorToastShownRef.current[name] = true;
      }
      setSaveStatus(name, 'error');
      scheduleRetry(name, requestResetKey);
    },
    [scheduleRetry, setSaveStatus]
  );

  const markSaveSettled = useCallback((name: OnboardingSaveName, requestResetKey: string) => {
    if (activeResetKeyRef.current !== requestResetKey) return;
    inFlightRef.current[name] = false;
  }, []);

  // Keep mutations in a ref so the effect re-runs only when inputs change,
  // not on every react-query state transition that produces a new
  // mutations object reference.
  const mutationsRef = useRef(mutations);
  mutationsRef.current = mutations;

  useEffect(() => {
    if (activeResetKeyRef.current === resetKey) return;

    activeResetKeyRef.current = resetKey;
    completedRef.current = createSaveFlags();
    inFlightRef.current = createSaveFlags();
    errorToastShownRef.current = createSaveFlags();
    clearRetryTimers();
    setStatuses(createSaveStatuses());
  }, [clearRetryTimers, resetKey]);

  useEffect(() => () => clearRetryTimers(), [clearRetryTimers]);

  useEffect(() => {
    const requestResetKey = resetKey;
    const plan = planOnboardingSaves({
      hasInstance,
      botIdentity,
      selectedPreset,
      channelTokens,
      completed: completedRef.current,
      inFlight: inFlightRef.current,
    });

    if (plan.botIdentity) {
      inFlightRef.current.botIdentity = true;
      clearRetryTimer('botIdentity');
      setSaveStatus('botIdentity', 'pending');
      mutationsRef.current.patchBotIdentity.mutate(
        {
          botName: plan.botIdentity.botName,
          botNature: plan.botIdentity.botNature,
          botVibe: plan.botIdentity.botVibe,
          botEmoji: plan.botIdentity.botEmoji,
        },
        {
          onSuccess: () => markSaveSucceeded('botIdentity', requestResetKey),
          onError: err => markSaveFailed('botIdentity', requestResetKey, err),
          onSettled: () => markSaveSettled('botIdentity', requestResetKey),
        }
      );
    }

    if (plan.execPreset) {
      inFlightRef.current.execPreset = true;
      clearRetryTimer('execPreset');
      setSaveStatus('execPreset', 'pending');
      mutationsRef.current.patchExecPreset.mutate(plan.execPreset, {
        onSuccess: () => markSaveSucceeded('execPreset', requestResetKey),
        onError: err => markSaveFailed('execPreset', requestResetKey, err),
        onSettled: () => markSaveSettled('execPreset', requestResetKey),
      });
    }

    if (plan.channels) {
      inFlightRef.current.channels = true;
      clearRetryTimer('channels');
      setSaveStatus('channels', 'pending');
      mutationsRef.current.patchChannels.mutate(plan.channels, {
        onSuccess: () => markSaveSucceeded('channels', requestResetKey),
        onError: err => markSaveFailed('channels', requestResetKey, err),
        onSettled: () => markSaveSettled('channels', requestResetKey),
      });
    }
  }, [
    hasInstance,
    botIdentity,
    selectedPreset,
    channelTokens,
    resetKey,
    retryTick,
    clearRetryTimer,
    markSaveFailed,
    markSaveSettled,
    markSaveSucceeded,
    setSaveStatus,
  ]);

  const resetInProgress = activeResetKeyRef.current !== resetKey;
  const readinessStatuses = resetInProgress ? createSaveStatuses() : statuses;
  const ready = areOnboardingSavesReady({
    hasInstance,
    botIdentity,
    selectedPreset,
    channelTokens,
    statuses: readinessStatuses,
  });
  const pending = SAVE_NAMES.some(name => readinessStatuses[name] === 'pending');

  return { ready, pending, statuses: readinessStatuses };
}
