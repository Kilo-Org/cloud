/* eslint-disable max-lines -- the dispatcher owns the lead/fallback session state machine, including the fallback permission hand-off. */
import {
  type VoiceInputNative,
  type VoiceInputNativeEvent,
  type VoiceInputNativePermission,
  type VoiceInputNativeStartOptions,
} from './voice-input-controller';
import {
  ACTIONABLE_FALLBACK_ERROR_CODES,
  BOTH_ENGINES_FAILED_CODE,
  fallbackEngineOf,
  leadEngineOf,
  NON_FALLBACK_ERROR_CODES,
  type VoiceInputEngineMode,
  type VoiceInputEngineName,
} from './voice-input-engine-mode';

type Attempt = 'lead' | 'fallback';

/**
 * Call an engine's stop/abort and swallow its throw: the idle engine has
 * nothing to stop or abort, and its failure is noise that must never mask
 * the active engine's error.
 */
function bestEffort(engine: VoiceInputNative, method: 'stop' | 'abort'): void {
  try {
    engine[method]();
  } catch {
    // The idle engine has nothing to stop/abort; its failure is noise.
  }
}

/**
 * Compose the OS recogniser binding and the gateway transcription engine
 * behind the single `VoiceInputNative` the controller consumes, switching on
 * a live mode probe so persisted preferences take effect without rebuilding
 * the controller.
 *
 * The dispatcher owns one session at a time. `start` launches the lead
 * engine; when the lead attempt fails with an engine failure (anything but
 * an abort or "no speech", and only while no transcript has been delivered
 * yet), the dispatcher swallows that error and starts the fallback engine
 * with the same options — after requesting the fallback engine's own
 * permission, which the lead's grant never covered (a gateway-primary user
 * holds expo-audio's microphone permission, not the OS recogniser's speech
 * permission). A denied or failing request does not end the session either:
 * the lead engine just recorded with its own microphone, so an error blaming
 * the user's microphone would be false, and a recogniser this device will
 * not let run is exactly what the re-arm contract covers. The session
 * continues behind the controller's back, and the fallback's transcript is
 * returned as if it had led. When the fallback fails too for a plain engine
 * reason, the session is not ended: the lead engine is re-armed and keeps
 * listening, so a recogniser that cannot capture audio (a simulator, a dead
 * input device) never consumes the session. If the user's next take fails on
 * the lead as well, both engines have failed in this session and exactly one
 * `voice-engines-failed` error is emitted (followed by `end`), never two raw
 * errors — unless the fallback's failure is a configuration problem with its
 * own actionable message (no model chosen, signed out), in which case that
 * single error surfaces as-is.
 *
 * `stop`/`abort` reach the engine that currently owns the session; `abort`
 * also best-effort aborts the idle engine, but only when the session was
 * allowed to involve the gateway at all. In `device-only` mode the gateway
 * binding receives no call of any kind.
 *
 * Permission probes ask the lead engine first and consult the fallback only
 * when the lead is denied, so a session can still start when just one engine
 * holds its microphone. `addListener` registers on the dispatcher's own
 * emitter; engine listeners are attached per session and dropped when it
 * ends, so an idle gateway stays untouched.
 */
export function createDispatchingVoiceInputNative(
  os: VoiceInputNative,
  gateway: VoiceInputNative,
  getMode: () => VoiceInputEngineMode
): VoiceInputNative {
  const engines = { os, gateway } satisfies Record<VoiceInputEngineName, VoiceInputNative>;

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

  // --- session state -------------------------------------------------------
  let active: VoiceInputEngineName | null = null;
  let activeAttempt: Attempt = 'lead';
  let pendingFallback: VoiceInputEngineName | null = null;
  let savedOptions: VoiceInputNativeStartOptions | null = null;
  let sawStart = false;
  let sawResult = false;
  let aborted = false;
  let combinedEmitted = false;
  let sessionMayUseGateway = false;
  let engineSubscriptions: { remove(): void }[] = [];
  /** Bumped on every session end/start; stales an in-flight permission continuation. */
  let sessionToken = 0;
  /** A stop that arrived while the fallback permission was still being asked. */
  let stopRequested = false;
  /**
   * The fallback engine has already failed once in this session. A later
   * lead failure then means both engines have failed, and the single
   * combined message is the honest surface — the user retried after the
   * hand-off and the lead died too.
   */
  let fallbackAttempted = false;

  const closeSession = (): void => {
    sessionToken += 1;
    active = null;
    activeAttempt = 'lead';
    pendingFallback = null;
    stopRequested = false;
    fallbackAttempted = false;
    for (const subscription of engineSubscriptions) {
      subscription.remove();
    }
    engineSubscriptions = [];
  };

  const reportBothEnginesFailed = (): void => {
    if (combinedEmitted) {
      return;
    }
    combinedEmitted = true;
    active = null;
    forward('error', {
      error: BOTH_ENGINES_FAILED_CODE,
      message: 'voice-input-engine-dispatch: both transcription engines failed',
    });
    forward('end', null);
    closeSession();
  };

  /**
   * The fallback engine died with a plain engine error (it cannot capture
   * audio on a simulator, or its input device is dead), or it could not be
   * started at all (its permission is denied): hand the session back to the
   * lead engine and keep listening instead of ending it on a failure the
   * user cannot retry into. The hand-off was already announced at the lead's
   * failure, so the lost take has its message either way. The user's next
   * take runs on the lead; if that fails too, `fallbackAttempted` makes it
   * the genuine both-engines failure and the single combined message. The
   * token bump stales any fallback-permission continuation still in flight
   * so it cannot start the dead engine again.
   */
  const rearmLeadEngine = (): void => {
    const lead = leadEngineOf(getMode());
    fallbackAttempted = true;
    sessionToken += 1;
    active = lead;
    activeAttempt = 'lead';
    if (savedOptions === null) {
      reportBothEnginesFailed();
      return;
    }
    try {
      engines[lead].start(savedOptions);
    } catch {
      reportBothEnginesFailed();
    }
  };

  type PermissionOutcome =
    | { kind: 'denied' }
    | { kind: 'failed' }
    | { kind: 'granted'; permission: VoiceInputNativePermission };

  const requestFallbackPermission = async (
    name: VoiceInputEngineName
  ): Promise<PermissionOutcome> => {
    try {
      const permission = await engines[name].requestPermissions();
      return permission.granted ? { kind: 'granted', permission } : { kind: 'denied' };
    } catch {
      return { kind: 'failed' };
    }
  };

  const startFallbackAttempt = (): void => {
    const name = pendingFallback;
    const options = savedOptions;
    if (name === null || options === null) {
      return;
    }
    pendingFallback = null;
    active = name;
    activeAttempt = 'fallback';
    // The gateway's own consent (the switch) covers the gateway upload; the
    // OS recogniser may still send audio to Apple/Google unless pinned to
    // on-device, and a fallback user never passed the OS consent flow.
    const startOptions: VoiceInputNativeStartOptions =
      name === 'os' ? { ...options, requiresOnDeviceRecognition: true } : options;
    // The fallback engine holds a permission the lead never needed: a
    // gateway-primary user granted expo-audio's microphone permission, not
    // the OS recogniser's speech permission. The dispatcher owns both
    // engines, so it asks before starting — without this the fallback dies
    // on 'not-allowed' and the session ends in the retryable combined
    // message that no retry can fix.
    const token = sessionToken;
    void (async (): Promise<void> => {
      const outcome = await requestFallbackPermission(name);
      if (token !== sessionToken) {
        // The session ended or a new one replaced it while the prompt was up.
        return;
      }
      if (aborted || stopRequested) {
        // The user ended the session while the permission prompt was up:
        // end quietly instead of starting an engine nobody listens to.
        forward('end', null);
        closeSession();
        return;
      }
      if (outcome.kind !== 'granted') {
        // The fallback cannot run on this device — its permission is denied
        // (a restricted recogniser, a dismissed prompt) or the probe itself
        // failed. Ending the session here on 'not-allowed' blamed the user's
        // microphone for the lead engine's failure while that microphone
        // was demonstrably on: the lead had just used it to record this
        // session. A recogniser the device will not let run is the case the
        // re-arm contract covers: the session returns to the lead engine and
        // keeps listening, so a spoken retry can still land. A second lead
        // failure then reports both engines in the one combined message.
        rearmLeadEngine();
        return;
      }
      try {
        engines[name].start(startOptions);
      } catch {
        // The engine cannot even be asked to listen: same contract as an
        // engine that dies before it starts — the session returns to the
        // lead rather than ending on a promise it cannot keep.
        rearmLeadEngine();
      }
    })();
  };

  // --- engine event handling ----------------------------------------------
  const onSimpleEvent = (
    name: VoiceInputEngineName,
    event: 'start' | 'transcribing' | 'nomatch'
  ): void => {
    if (name !== active) {
      return;
    }
    if (event === 'start') {
      // The controller has seen this session go live (Listening…), so a
      // later lead failure discards a take the user believes was captured.
      sawStart = true;
    }
    forward(event, null);
  };

  const onResult = (name: VoiceInputEngineName, event: VoiceInputNativeEvent['result']): void => {
    if (name !== active) {
      return;
    }
    const transcript = event.results[0]?.transcript ?? '';
    if (transcript.length > 0) {
      sawResult = true;
    }
    forward('result', event);
  };

  const onError = (name: VoiceInputEngineName, event: VoiceInputNativeEvent['error']): void => {
    if (name !== active) {
      return;
    }
    if (aborted || event.error === 'aborted') {
      forward('error', event);
      return;
    }
    if (activeAttempt === 'fallback') {
      if (NON_FALLBACK_ERROR_CODES.has(event.error)) {
        // Silence on the backup is still silence, not a broken engine: the
        // no-speech copy is the honest message.
        forward('error', event);
        return;
      }
      if (ACTIONABLE_FALLBACK_ERROR_CODES.has(event.error)) {
        // The backup failed for a configuration reason the user can fix
        // right now (no model chosen, signed out, dead model): its own
        // actionable, non-retryable message beats the combined retryable
        // one — a retry would only fail the same way again.
        forward('error', event);
        return;
      }
      if (stopRequested) {
        // The user stopped this attempt to seal a take and the engine died
        // on the way: the take is gone and both engines have failed in this
        // session. One message naming both is the honest surface.
        reportBothEnginesFailed();
        return;
      }
      // The backup failed with a plain engine error while the session was
      // still open: keep the session alive on the lead engine (see
      // `rearmLeadEngine`). The hand-off message already made its promise
      // only if the backup ever went live; a recogniser that cannot capture
      // audio must not consume the session.
      rearmLeadEngine();
      return;
    }
    if (NON_FALLBACK_ERROR_CODES.has(event.error) || sawResult || pendingFallback === null) {
      if (
        pendingFallback === null &&
        fallbackAttempted &&
        !NON_FALLBACK_ERROR_CODES.has(event.error) &&
        !sawResult
      ) {
        // The user retried after the fallback died and the lead failed
        // again: both engines have now failed in this session, so exactly
        // one message names both.
        reportBothEnginesFailed();
        return;
      }
      // Terminal: silence and aborts are content or the user's own decision,
      // a delivered result means the session already gave the user their
      // words, and with no fallback engine there is nothing to hand off to.
      // Surface the honest error.
      forward('error', event);
      return;
    }
    // The lead attempt failed with a real engine error: swallow it and let
    // the other engine carry the session. The lead's `end` is dropped below
    // because the active engine has already moved on. When the session had
    // already gone live, the take the user just recorded is lost and the
    // hand-off is announced now — the pill flipping back to Listening…
    // carries the reason and the ask to repeat the lost take. The session
    // does keep going whichever way the fallback attempt lands: a live
    // fallback makes the direction toast literally true, and a fallback this
    // device will not let run (denied permission, no audio input) re-arms
    // the lead instead, so the same ask still has somewhere to land and the
    // next lead failure is the one combined both-engines message. This also
    // covers a failure after the user's stop: the sealed take died with the
    // upload, so the consumed stop must not make the fallback continuation
    // end the session quietly (the scenarios' ask: stop, fall back, and a
    // repeated utterance still lands).
    if (sawStart) {
      forward('engine-fell-back', { from: name, to: pendingFallback });
    }
    stopRequested = false;
    startFallbackAttempt();
  };

  const onEnd = (name: VoiceInputEngineName): void => {
    if (name !== active) {
      return;
    }
    forward('end', null);
    closeSession();
  };

  const subscribeEngine = (name: VoiceInputEngineName): void => {
    const engine = engines[name];
    engineSubscriptions.push(
      engine.addListener('start', () => {
        onSimpleEvent(name, 'start');
      }),
      engine.addListener('transcribing', () => {
        onSimpleEvent(name, 'transcribing');
      }),
      engine.addListener('result', event => {
        onResult(name, event);
      }),
      engine.addListener('nomatch', () => {
        onSimpleEvent(name, 'nomatch');
      }),
      engine.addListener('error', event => {
        onError(name, event);
      }),
      engine.addListener('end', () => {
        onEnd(name);
      })
    );
  };

  // --- probes ---------------------------------------------------------------
  const probePermissions = async (
    method: 'getPermissions' | 'requestPermissions'
  ): Promise<VoiceInputNativePermission> => {
    const mode = getMode();
    const lead = leadEngineOf(mode);
    const fallback = fallbackEngineOf(mode);
    const first = await engines[lead][method]();
    if (first.granted || fallback === null) {
      return first;
    }
    // The lead lacks its microphone; the fallback may still carry the
    // session, so ask it before declaring the whole flow blocked.
    const second = await engines[fallback][method]();
    return second.granted ? second : first;
  };

  return {
    addListener<K extends keyof VoiceInputNativeEvent>(
      event: K,
      listener: (event: VoiceInputNativeEvent[K]) => void
    ) {
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
      const permission = await probePermissions('getPermissions');
      return permission;
    },
    requestPermissions: async () => {
      const permission = await probePermissions('requestPermissions');
      return permission;
    },
    isRecognitionAvailable: () => {
      const mode = getMode();
      if (mode === 'device-only') {
        return os.isRecognitionAvailable();
      }
      // Either engine can carry the session, so either one's availability
      // surfaces the mic button.
      const lead = leadEngineOf(mode);
      const fallback = fallbackEngineOf(mode);
      return (
        engines[lead].isRecognitionAvailable() ||
        (fallback !== null && engines[fallback].isRecognitionAvailable())
      );
    },
    supportsContinuousRecognition: () =>
      engines[leadEngineOf(getMode())].supportsContinuousRecognition(),
    supportsOnDevice: () => engines[leadEngineOf(getMode())].supportsOnDevice(),
    start: (options: VoiceInputNativeStartOptions): void => {
      closeSession();
      savedOptions = options;
      sawStart = false;
      sawResult = false;
      aborted = false;
      combinedEmitted = false;
      const mode = getMode();
      sessionMayUseGateway = mode !== 'device-only';
      const lead = leadEngineOf(mode);
      const fallback = fallbackEngineOf(mode);
      pendingFallback =
        fallback !== null && engines[fallback].isRecognitionAvailable() ? fallback : null;
      subscribeEngine(lead);
      if (pendingFallback !== null) {
        subscribeEngine(pendingFallback);
      }
      if (!engines[lead].isRecognitionAvailable() && pendingFallback !== null) {
        // The lead cannot run at all: the backup engine becomes the session's
        // only engine, and its failures surface directly — there is nothing
        // left to fall back to, so no combined message.
        const sole = pendingFallback;
        pendingFallback = null;
        active = sole;
        activeAttempt = 'lead';
        try {
          engines[sole].start(options);
        } catch (error) {
          closeSession();
          throw error;
        }
        return;
      }
      active = lead;
      activeAttempt = 'lead';
      try {
        engines[lead].start(options);
      } catch (error) {
        if (pendingFallback === null) {
          closeSession();
          throw error;
        }
        startFallbackAttempt();
      }
    },
    stop: (): void => {
      if (active === null) {
        return;
      }
      // The stop reaches the engine that owns the session. It only ends the
      // session quietly when it lands while the fallback permission is still
      // being asked; a lead failure that follows a stop still hands the
      // session to the fallback (the onError path clears this flag, since
      // that stop was consumed by the failed lead attempt).
      stopRequested = true;
      engines[active].stop();
    },
    abort: (): void => {
      aborted = true;
      const current = active;
      if (current === null) {
        return;
      }
      try {
        engines[current].abort();
      } finally {
        if (sessionMayUseGateway) {
          bestEffort(engines[current === 'os' ? 'gateway' : 'os'], 'abort');
        }
      }
    },
  };
}
