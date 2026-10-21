// One dispatch for every way an action reaches the app.
//
// Both entry points funnel here: the native bridge handler (a payload handed to
// the registered JS handler) and a request parked by the URL rails
// (`action-url-handler.ts`) and picked up by the tabs consumer. `StartAgent`
// asks the signed-in user before it starts, and is the only action that can
// fail in a way the caller has to hear about; every outcome belongs to the app,
// which is the surface that shows it.

import { i18n } from '@/i18n';

import {
  appActionHref,
  type AppActionRequest,
  type AppActionResult,
  parseAppActionPayload,
  type StartAgentRequest,
} from './app-action-contract';
import { setPendingAppAction } from './pending-app-action';

/** The `StartAgent` request without its discriminant: what `start-agent.ts` takes. */
type StartAgentInput = Omit<StartAgentRequest, 'action'>;

/**
 * The headless create, the native bridge, and Sentry — loaded on demand rather
 * than imported.
 *
 * `index.js` registers this dispatcher at boot, before any screen mounts, and
 * the tabs layout imports it on every launch. A static import would evaluate
 * the create module (its tRPC client, outbox and query graph), the native
 * bridge's optional module lookup, and Sentry's React Native graph on every one
 * of those launches, including the ones that run no action and the screens that
 * mount without one failing.
 */
export type AppActionDispatcherDeps = {
  startAgent: (input: StartAgentInput) => Promise<AppActionResult>;
  /**
   * Asks the signed-in user to confirm a `StartAgent` before it starts, and
   * resolves whether they chose to start it.
   */
  confirmStartAgent: (request: StartAgentRequest) => Promise<boolean>;
};

const defaultDeps: AppActionDispatcherDeps = {
  startAgent: async input => {
    const { startAgent } = await import('./start-agent');
    return startAgent(input);
  },
  confirmStartAgent: async request => {
    const { confirmStartAgent } = await import('./start-agent-confirmation');
    return confirmStartAgent(request);
  },
};

/**
 * How the request reached the dispatcher.
 *
 * `StartAgent` starts a session in the signed-in account, so the app asks the
 * user before it runs. The default is to ask. A platform entry point that runs
 * with no screen and passes false is declared by its own native module
 * (`native-bridge.ts`).
 */
export type AppActionDispatchOptions = {
  /** Ask the user before a `StartAgent` starts. Defaults to true. */
  requireStartAgentConfirmation?: boolean;
};

/**
 * Reports one error to Sentry. A failed report is swallowed: it is cosmetic,
 * and must not mask the dispatch outcome it is reporting.
 */
async function captureAppActionError(error: unknown, operation: string): Promise<void> {
  try {
    const { captureException } = await import('@sentry/react-native');
    captureException(error, {
      tags: { 'error.subsystem': 'app_actions', 'error.operation': operation },
    });
  } catch {
    // Reporting is cosmetic; a failed report must not mask the dispatch outcome.
  }
}

/**
 * The refusal for an open action whose input the resolvers cannot turn into a
 * destination: `null` for `StartAgent` and `OpenNeedsInput` (neither is
 * answered by a URL-named destination) and for a request `appActionHref`
 * resolves to a destination; otherwise the `not-a-pull-request` refusal. In
 * practice only an `OpenPullRequest` link the provider resolvers do not
 * recognize reaches the refusal: the contract's builders return string paths,
 * and such a link resolves to nothing. Re-running cannot change that, so the
 * refusal is non-retryable.
 *
 * One source for the message: `dispatchAppActionRequest` returns it to the OS
 * caller, and the tabs consumer reports it for the same request when the URL
 * rails park it (`(tabs)/_layout.tsx`).
 */
export function unresolvedOpenActionRefusal(request: AppActionRequest): AppActionResult | null {
  if (request.action === 'StartAgent' || request.action === 'OpenNeedsInput') {
    return null;
  }
  const href = appActionHref(request);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary: the contract's `Href` result enters the string-carrying `AppActionResult`
  if (typeof href === 'string') {
    return null;
  }
  return {
    ok: false,
    action: request.action,
    retryable: false,
    code: 'not-a-pull-request',
    message: i18n.t('prReview.linkPasteNotAPullRequest'),
  };
}

/**
 * Run one action request and report the outcome the caller shows.
 *
 * `StartAgent` asks the user first, then runs the create and parks the session
 * it produced; the open actions park their destination, because the tabs
 * layout — not this pure module — owns the router and the live session list.
 * Never rejects: a caller has to get an outcome, even when the app could not
 * produce one.
 */
export async function dispatchAppActionRequest(
  request: AppActionRequest,
  deps: AppActionDispatcherDeps = defaultDeps,
  options: AppActionDispatchOptions = {}
): Promise<AppActionResult> {
  if (request.action === 'StartAgent') {
    if (options.requireStartAgentConfirmation !== false) {
      const confirmed = await deps.confirmStartAgent(request);
      if (!confirmed) {
        // Nothing runs and nothing is parked: the account is untouched, and the
        // surface that asked reports that the user declined.
        return { ok: false, action: 'StartAgent', code: 'declined', retryable: false, message: '' };
      }
    }
    const result = await runStartAgent(request, deps);
    if (result.ok && result.sessionId !== undefined) {
      // The move the in-app create makes through `replaceWithAgentSession`
      // (`session-detail-routes.ts:45`): show the session the run created. The
      // app may have been closed when the action ran, so park instead of
      // navigating — the tabs consumer navigates once the shell is ready.
      setPendingAppAction({ action: 'OpenSession', sessionId: result.sessionId });
    }
    return result;
  }

  if (request.action === 'OpenNeedsInput') {
    // Data-dependent: the tabs consumer answers it from the live list once that
    // list has settled, so park the request and report that it was accepted.
    setPendingAppAction(request);
    return { ok: true, action: 'OpenNeedsInput', message: '' };
  }

  const refusal = unresolvedOpenActionRefusal(request);
  if (refusal !== null) {
    return refusal;
  }
  // A null refusal is exactly a resolved destination, and the contract's
  // builders only construct the string branch of `Href` — narrow the way
  // `getSpawnedAgentSessionPath` does rather than re-deriving the check the
  // refusal just made.
  const href = appActionHref(request) as string;
  setPendingAppAction(request);
  return {
    ok: true,
    action: request.action,
    href,
    ...(request.action === 'OpenSession' ? { sessionId: request.sessionId } : {}),
    message: '',
  };
}

/** The create, with the outcome a caller can always be given. */
async function runStartAgent(
  request: StartAgentRequest,
  deps: AppActionDispatcherDeps
): Promise<AppActionResult> {
  const input: StartAgentInput = {
    prompt: request.prompt,
    ...(request.repository === undefined ? {} : { repository: request.repository }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  };
  try {
    return await deps.startAgent(input);
  } catch (error) {
    await captureAppActionError(error, 'start_agent');
    return {
      ok: false,
      action: 'StartAgent',
      retryable: true,
      code: 'start-failed',
      message: i18n.t('agentChat.session.serviceUnavailable'),
    };
  }
}

/**
 * Register the JS dispatcher with the native module and replay, in order, the
 * payloads that arrived before registration.
 *
 * Called once from `index.js` after `expo-router/entry`, which is what makes an
 * action that arrives before any screen mounts (StartAgent with the app closed)
 * still run. A missing native module registers nothing and is not an error; a
 * registration failure is reported and swallowed so a boot path never dies of it.
 */
export async function registerAppActionDispatcher(): Promise<void> {
  try {
    const { registerNativeAppActionDispatcher } = await import('./native-bridge');
    const { handle, buffered } = await registerNativeAppActionDispatcher(
      handleNativeAppActionPayload
    );
    // Replayed in arrival order: a StartAgent has to finish — and park the
    // session it created — before the request behind it acts. Each one runs
    // through the registered handler, so a payload that arrived while the app
    // was cold runs exactly like a live dispatch.
    for (const payload of buffered) {
      try {
        // eslint-disable-next-line no-await-in-loop -- arrival order is the contract
        await handle(payload);
      } catch {
        // A buffered payload the contract does not recognize is dropped rather
        // than failing the replay: the buffer is a delivery buffer, not a
        // validation surface.
      }
    }
  } catch (error) {
    await captureAppActionError(error, 'register_dispatcher');
  }
}

/**
 * The handler native code calls for one payload. A payload the contract does not
 * recognize is a caller bug: reject rather than invent an action to report it
 * against.
 *
 * Whether a `StartAgent` asks the user first is the platform's own answer, read
 * from its native module.
 */
async function handleNativeAppActionPayload(payload: unknown): Promise<AppActionResult> {
  const request = parseAppActionPayload(payload);
  if (request === null) {
    throw new Error('The app action payload does not match the app action contract.');
  }
  const { startAgentNeedsConfirmation } = await import('./native-bridge');
  return dispatchAppActionRequest(request, defaultDeps, {
    requireStartAgentConfirmation: startAgentNeedsConfirmation(),
  });
}
