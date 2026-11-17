import { z } from 'zod';

/**
 * Every browser-tool caller the background runtime serves. The side panel and
 * the workflow runner are the only callers wired today; `agent` callers arrive
 * with the CLI bridge, and the runtime's dispatch accepts them already so the
 * lease rules (agents wait, panels take over) are testable now.
 */
export const browserCallerSchema = z.discriminatedUnion('kind', [
  z.object({
    conversationId: z.string().min(1),
    kind: z.literal('panel'),
    panelId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('workflow'),
    runId: z.string().min(1),
  }),
  z.object({
    controllerId: z.string().min(1),
    kind: z.literal('agent'),
    sessionHandle: z.string().min(1),
  }),
]);

export type BrowserCaller = z.infer<typeof browserCallerSchema>;

/** One stable key per caller, used for leases and per-caller ref registries. */
export const browserCallerKey = (caller: BrowserCaller): string => {
  switch (caller.kind) {
    case 'agent':
      return `agent:${encodeURIComponent(caller.controllerId)}:${encodeURIComponent(caller.sessionHandle)}`;
    case 'panel':
      return `panel:${encodeURIComponent(caller.panelId)}:${encodeURIComponent(caller.conversationId)}`;
    case 'workflow':
      return `workflow:${encodeURIComponent(caller.runId)}`;
  }
};

/**
 * A retryable tool error: a tab leased to another caller did not come free
 * before the caller's wait ran out. The message names the state the retry
 * policy keys on, and the call never partially ran.
 */
export const TAB_BUSY_ERROR =
  'The tab is in use by another browser session (tab_busy). Retry the call.';

/**
 * A retryable tool error: the side panel took the tab over while this call was
 * in flight. Its page effects may have landed or not, so the next call must
 * re-observe the page instead of replaying this one.
 */
export const TAB_TAKEN_ERROR =
  'The side panel took over the tab (tab_taken). Take a fresh snapshot before retrying.';
