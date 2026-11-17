/* eslint-disable max-lines -- The gate owns grant matching, frame target resolution, sensitive classification and the post-navigate check; splitting it would scatter the pre-action contract. */
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
import type { BrowserAgentFrame } from './browser-agent-frames';
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

const formFieldTargetsSchema = z.array(
  z.object({ ref: z.string().optional(), selector: z.string().optional() })
);

const argumentString = (args: Record<string, unknown>, key: string): string | undefined => {
  const parsed = argumentTextSchema.safeParse(args[key]);

  return parsed.success ? parsed.data : undefined;
};

/** A resolved target whose frame cannot be established: no grant can cover it. */
const OPAQUE_ORIGIN = 'opaque:null';

interface TargetFrame {
  /** The target sits in a child frame, not the tab's top-level document. */
  readonly frame: boolean;
  readonly origin: string;
}

/**
 * Every element target an act tool accepts: the single-target keys, one target
 * per `browser_fill_form` field, and both ends of a `browser_drag`.
 */
const targetTextsOf = (args: Record<string, unknown>): readonly string[] => {
  const texts: string[] = [];

  for (const key of ['element', 'target', 'ref', 'selector', 'startTarget', 'endTarget']) {
    const text = argumentString(args, key);

    if (text !== undefined) {
      texts.push(text);
    }
  }

  const fields = formFieldTargetsSchema.safeParse(args['fields']);

  for (const field of fields.success ? fields.data : []) {
    const text = argumentString(field, 'ref') ?? argumentString(field, 'selector');

    if (text !== undefined) {
      texts.push(text);
    }
  }

  return [...new Set(texts)];
};

/**
 * The frame one target lives in (`DOM.Node.frameId`). An unresolvable target
 * yields nothing — the tool reports its own missing-element error, which is the
 * accurate outcome; a resolved target whose frame is unknown yields the opaque
 * origin so the call is refused instead of falling back to the tab's origin.
 */
const targetFrameOf = async (
  session: GateSession,
  frames: readonly BrowserAgentFrame[],
  target: string
): Promise<TargetFrame | undefined> => {
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
    return { frame: true, origin: OPAQUE_ORIGIN };
  }

  const frame = frames.find(candidate => candidate.id === frameId);

  return frame === undefined
    ? { frame: true, origin: OPAQUE_ORIGIN }
    : { frame: frame.parentId !== undefined, origin: frame.origin };
};

/** The origin a navigate is headed for; a `browser_navigate_back` has no URL to read. */
const navigationOrigin = (args: Record<string, unknown>): string | undefined => {
  const url = argumentString(args, 'url');

  return url === undefined ? undefined : toBrowserOrigin(url);
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
  const mainOrigin = mainFrameOf(frames)?.origin ?? OPAQUE_ORIGIN;
  const targetTexts = grantClass === 'navigate' ? [] : targetTextsOf(input.args);
  const targetFrames: TargetFrame[] = [];

  for (const text of targetTexts) {
    // eslint-disable-next-line no-await-in-loop -- one target's frame per round trip, in argument order
    const targetFrame = await targetFrameOf(input.session, frames, text);

    if (targetFrame !== undefined) {
      targetFrames.push(targetFrame);
    }
  }

  const destination = grantClass === 'navigate' ? navigationOrigin(input.args) : undefined;
  const [target] = targetTexts;
  const [primaryTargetFrame] = targetFrames;
  const targetFrame =
    primaryTargetFrame === undefined
      ? undefined
      : { frame: primaryTargetFrame.frame, origin: primaryTargetFrame.origin };
  const origin = destination ?? targetFrame?.origin ?? mainOrigin;
  const targetOriginFrame = grantClass !== 'navigate' && targetFrame?.frame === true;
  // Every named target's frame needs the grant, not only the tab's top-level origin.
  const requiredOrigins = new Set<string>(targetFrames.map(frame => frame.origin));
  const frameByOrigin = new Map(targetFrames.map(frame => [frame.origin, frame.frame]));

  if (requiredOrigins.size === 0) {
    requiredOrigins.add(origin);
  }

  const missing = [...requiredOrigins].filter(
    required => !isOriginGranted(input.authorized, grantClass, required)
  );

  if (missing.length > 0) {
    const items: BrowserPermissionItem[] = missing.map(required =>
      frameByOrigin.get(required) === true
        ? { class: grantClass, frame: true, origin: required }
        : { class: grantClass, origin: required }
    );

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
