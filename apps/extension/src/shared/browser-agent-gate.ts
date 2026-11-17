import { z } from 'zod';
import {
  hashBrowserToolArguments,
  isOAuthConsentUrl,
  isOriginGranted,
  isUploadTool,
  SENSITIVE_REASON,
  sensitiveReasonForField,
  toBrowserOrigin,
  toolGrantClass,
} from './browser-agent-checks';
import type {
  BrowserGrant,
  BrowserNeedsPermission,
  BrowserOriginChanged,
  BrowserPermissionItem,
  BrowserSensitiveProbe,
  StepTokenBinding,
} from './browser-agent-checks';
import { mainFrameOf, readAgentFrameTree } from './browser-agent-frames';
import { readSensitiveProbeForTarget, sensitiveTargetsOf } from './browser-agent-probes';
import type { BrowserToolPageSession } from './browser-tool-snapshot';
import type { BrowserToolSession } from './browser-tool-session';

/**
 * The agent check module (SPEC "Permission flow", D3, D4, D11): before a CLI
 * agent's call runs, the real origin is resolved at action time — the tab
 * after redirects, or the frame a ref lives in — and a sensitive step needs a
 * single-use token bound to this exact call.
 */

type GateSession = Pick<BrowserToolPageSession, 'send' | 'resolveTarget'> &
  Pick<BrowserToolSession, 'takeDownloads'>;

export interface BrowserSensitiveStep {
  readonly element?: string | undefined;
  readonly origin: string;
  readonly reason: string;
}

export type AgentPreflight =
  | {
      readonly class: 'act' | 'navigate' | 'read';
      /** The origin the call was authorized for: the frame's, or the destination's for a navigate. */
      readonly ok: true;
      readonly origin: string;
      /** The step token this call consumed, when it was a sensitive step. */
      readonly sensitiveToken?: string | undefined;
      /** The target lives inside a child frame. */
      readonly targetOriginFrame: boolean;
    }
  | {
      readonly failure: BrowserNeedsPermission | BrowserOriginChanged;
      readonly ok: false;
      /** Present when the refusal is a sensitive step: the runtime issues the token. */
      readonly sensitive?: BrowserSensitiveStep | undefined;
    };

const describeNodeSchema = z.object({
  node: z.object({ frameId: z.string().optional() }).optional(),
});

const argumentTextSchema = z.string().min(1);

const argumentString = (args: Record<string, unknown>, key: string): string | undefined => {
  const parsed = argumentTextSchema.safeParse(args[key]);

  return parsed.success ? parsed.data : undefined;
};

const targetOfArguments = (args: Record<string, unknown>): string | undefined =>
  argumentString(args, 'element') ??
  argumentString(args, 'target') ??
  argumentString(args, 'ref') ??
  argumentString(args, 'selector');

/** The origin a navigate is headed for; a `browser_navigate_back` has no URL to read. */
const navigationOrigin = (args: Record<string, unknown>): string | undefined => {
  const url = argumentString(args, 'url');

  return url === undefined ? undefined : toBrowserOrigin(url);
};

/**
 * The frame the target element lives in (`DOM.Node.frameId`), or `undefined`
 * when the target does not resolve — the tool then reports its own
 * missing-element error, which is the accurate outcome.
 */
const targetFrameOrigin = async (
  session: GateSession,
  target: string | undefined
): Promise<{ readonly frame: boolean; readonly origin: string } | undefined> => {
  if (target === undefined) {
    return undefined;
  }

  const resolved = await session.resolveTarget(target);

  if (resolved === undefined) {
    return undefined;
  }

  const response = await session.send(
    'DOM.describeNode',
    resolved.kind === 'ref'
      ? { backendNodeId: resolved.backendNodeId }
      : { nodeId: resolved.nodeId }
  );

  if (response === undefined) {
    return undefined;
  }

  const parsed = describeNodeSchema.safeParse(response);
  const frameId = parsed.success ? parsed.data.node?.frameId : undefined;

  if (frameId === undefined) {
    return undefined;
  }

  const frames = await readAgentFrameTree(session);
  const frame = frames.find(candidate => candidate.id === frameId);

  return frame === undefined
    ? undefined
    : { frame: frame.parentId !== undefined, origin: frame.origin };
};

const firstReasonOf = (probe: BrowserSensitiveProbe): string | undefined => {
  if (probe.paymentFormSubmit) {
    return SENSITIVE_REASON.cardFormSubmit;
  }

  const [field] = probe.fields;

  return field === undefined ? undefined : sensitiveReasonForField(field.kind);
};

/**
 * Classifies one act call as a sensitive step: a file upload, an OAuth consent
 * page, typing into or submitting a password/one-time-code/payment field. A
 * download that the call starts is classified after it ran, by the runtime.
 */
const sensitiveStepFor = async (input: {
  readonly args: Record<string, unknown>;
  readonly origin: string;
  readonly pageUrl: string | undefined;
  readonly session: GateSession;
  readonly toolName: string;
}): Promise<BrowserSensitiveStep | undefined> => {
  if (isUploadTool(input.toolName)) {
    return { origin: input.origin, reason: SENSITIVE_REASON.fileUpload };
  }

  if (isOAuthConsentUrl(input.pageUrl)) {
    return { origin: input.origin, reason: SENSITIVE_REASON.oauthConsent };
  }

  const targets = sensitiveTargetsOf(input.toolName, input.args);

  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop -- one probe per targeted element, in argument order
    const probe = await readSensitiveProbeForTarget(input.session, target);
    const reason = firstReasonOf(probe);

    if (reason !== undefined) {
      return { element: target, origin: input.origin, reason };
    }
  }

  return undefined;
};

const pageUrlFor = async (
  session: GateSession,
  frame: { readonly frame: boolean; readonly origin: string } | undefined
): Promise<string | undefined> => {
  const frames = await readAgentFrameTree(session);
  const main = mainFrameOf(frames);

  if (frame !== undefined && frame.frame) {
    const match = frames.find(candidate => candidate.origin === frame.origin);

    if (match !== undefined) {
      return match.url;
    }
  }

  return main?.url;
};

export interface AgentPreflightInput {
  readonly args: Record<string, unknown>;
  /** The pairs the CLI already approved for this session. */
  readonly authorized: readonly BrowserGrant[];
  /** Validates a token against this exact call and burns it; provided by the runtime's store. */
  readonly consumeStepToken: (token: string, binding: StepTokenBinding) => boolean;
  readonly session: GateSession;
  /** The step tokens the retry carried. */
  readonly stepTokens: readonly string[];
  readonly tabId: number;
  readonly toolName: string;
}

/**
 * The pre-action check: the needed class origin is granted, and an act call
 * that would be sensitive carries a token bound to this tab, tool, element
 * and argument set.
 */
export const preflightAgentCall = async (input: AgentPreflightInput): Promise<AgentPreflight> => {
  const grantClass = toolGrantClass(input.toolName);
  const frames = await readAgentFrameTree(input.session);
  const mainOrigin = mainFrameOf(frames)?.origin ?? 'opaque:null';
  const target = targetOfArguments(input.args);
  const targetFrame = await targetFrameOrigin(input.session, target);
  const destination = grantClass === 'navigate' ? navigationOrigin(input.args) : undefined;
  const origin = destination ?? targetFrame?.origin ?? mainOrigin;
  const targetOriginFrame = grantClass !== 'navigate' && targetFrame?.frame === true;

  if (!isOriginGranted(input.authorized, grantClass, origin)) {
    const items: BrowserPermissionItem[] = [
      { class: grantClass, origin, ...(targetOriginFrame ? { frame: true } : {}) },
    ];

    return { failure: { items, kind: 'needs_permission' }, ok: false };
  }

  if (grantClass !== 'act') {
    return { class: grantClass, ok: true, origin, targetOriginFrame };
  }

  const pageUrl = await pageUrlFor(input.session, targetFrame);
  const sensitive = await sensitiveStepFor({
    args: input.args,
    origin,
    pageUrl,
    session: input.session,
    toolName: input.toolName,
  });

  if (sensitive === undefined) {
    return { class: grantClass, ok: true, origin, targetOriginFrame };
  }

  const binding: StepTokenBinding = {
    argumentHash: hashBrowserToolArguments(input.args),
    element: target,
    origin,
    tabId: input.tabId,
    toolName: input.toolName,
  };
  const matched = input.stepTokens.find(token => input.consumeStepToken(token, binding));

  if (matched !== undefined) {
    return { class: 'act', ok: true, origin, sensitiveToken: matched, targetOriginFrame };
  }

  return {
    failure: {
      items: [{ class: 'sensitive', origin, reason: sensitive.reason }],
      kind: 'needs_permission',
    },
    ok: false,
    sensitive,
  };
};

/**
 * The post-action check for a navigate: a redirect moved the tab to another
 * origin than the one the navigation was approved for. The caller must ask for
 * that origin and decide whether to stay.
 */
export const postAgentNavigate = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  approvedOrigin: string
): Promise<BrowserOriginChanged | undefined> => {
  const frames = await readAgentFrameTree(session);
  const finalOrigin = mainFrameOf(frames)?.origin;

  return finalOrigin === undefined || finalOrigin === approvedOrigin
    ? undefined
    : { from: approvedOrigin, kind: 'origin_changed', to: finalOrigin };
};

/**
 * Downloads the tab started since the last check. An act call that started one
 * without a sensitive token had it cancelled by the download guard and is
 * refused as a sensitive step.
 */
export const takeStartedDownloads = (session: Pick<BrowserToolSession, 'takeDownloads'>): number =>
  session.takeDownloads().length;
