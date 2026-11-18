/* eslint-disable max-lines -- The gate owns grant matching, frame target resolution, sensitive classification and the post-navigate check; splitting it would scatter the pre-action contract. */
import { z } from 'zod';
import {
  ambiguousSelectorError,
  hashBrowserToolArguments,
  isOAuthConsentUrl,
  isOriginGranted,
  isUploadTool,
  SENSITIVE_REASON,
  toBrowserOrigin,
  toolGrantClass,
} from './browser-agent-checks';
import type {
  BrowserGrant,
  BrowserNeedsPermission,
  BrowserOriginChanged,
  BrowserPermissionItem,
  StepTokenBinding,
} from './browser-agent-checks';
import { mainFrameOf, readAgentFrameTree } from './browser-agent-frames';
import type { BrowserAgentFrame } from './browser-agent-frames';
import {
  classifyFocusedElement,
  classifyTargetElement,
  sensitiveTargetsOf,
} from './browser-agent-probes';
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
      readonly failure:
        | BrowserNeedsPermission
        | BrowserOriginChanged
        | { readonly error: string; readonly kind: 'blocked' };
      readonly ok: false;
      /** Present when the refusal is a sensitive step: the runtime issues the token. */
      readonly sensitive?: BrowserSensitiveStep | undefined;
    };

const describeNodeSchema = z.object({
  node: z.object({ frameId: z.string().optional() }).optional(),
});

const argumentTextSchema = z.string().min(1);

/** A `browser_fill_form` field as the vendored contract carries it: `target` is the element reference. */
const formFieldTargetsSchema = z.array(
  z.object({
    element: z.string().optional(),
    name: z.string().optional(),
    target: z.string().optional(),
    type: z.string().optional(),
    value: z.string().optional(),
  })
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
/**
 * The element references a call carries, without human-readable descriptions:
 * a description may coincide with several elements and must not be resolved.
 */
const targetReferencesOf = (args: Record<string, unknown>): readonly string[] => {
  const texts: string[] = [];

  for (const key of ['target', 'startTarget', 'endTarget']) {
    const text = argumentString(args, key);

    if (text !== undefined) {
      texts.push(text);
    }
  }

  const fields = formFieldTargetsSchema.safeParse(args['fields']);

  for (const field of fields.success ? fields.data : []) {
    const text = argumentString(field, 'target');

    if (text !== undefined) {
      texts.push(text);
    }
  }

  return [...new Set(texts)];
};

const targetTextsOf = (args: Record<string, unknown>): readonly string[] => {
  const texts: string[] = [];

  for (const key of ['target', 'ref', 'selector', 'startTarget', 'endTarget']) {
    const text = argumentString(args, key);

    if (text !== undefined) {
      texts.push(text);
    }
  }

  const fields = formFieldTargetsSchema.safeParse(args['fields']);

  for (const field of fields.success ? fields.data : []) {
    const text = argumentString(field, 'target');

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

  if (resolved.kind === 'ambiguous') {
    // The call is refused later as ambiguous; it adds no origin requirement here.
    return undefined;
  }

  const response = await session.send(
    'DOM.describeNode',
    resolved.kind === 'ref'
      ? { backendNodeId: resolved.backendNodeId }
      : { nodeId: resolved.nodeId }
  );

  if (response === undefined) {
    return { frame: true, origin: OPAQUE_ORIGIN };
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

const frameOwnerSchema = z.object({ backendNodeId: z.number().optional() });

/** One frame's owner backendNodeId, or undefined when the frame's owner cannot be read. */
const frameOwnerBackendNodeId = async (
  session: GateSession,
  frameId: string
): Promise<number | undefined> => {
  try {
    const owner = frameOwnerSchema.safeParse(await session.send('DOM.getFrameOwner', { frameId }));

    return owner.success ? owner.data.backendNodeId : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The origin of the frame whose owner element is this node. The handle comes from
 * the same read that found focus, so a page mutating its DOM cannot redirect it
 * to another frame; an unmatched frame is opaque and the others keep their origins.
 */
const frameOriginForOwner = async (
  session: GateSession,
  frames: readonly BrowserAgentFrame[],
  backendNodeId: number
): Promise<string> => {
  const children = frames.filter(frame => frame.parentId !== undefined);
  const owners = await Promise.all(
    children.map(child => frameOwnerBackendNodeId(session, child.id))
  );
  const match = children.find((_child, position) => owners[position] === backendNodeId);

  return match?.origin ?? OPAQUE_ORIGIN;
};

/** The origin a navigate is headed for; a `browser_navigate_back` has no URL to read. */
const navigationOrigin = (args: Record<string, unknown>): string | undefined => {
  const url = argumentString(args, 'url');

  return url === undefined ? undefined : toBrowserOrigin(url);
};

/**
 * Classifies one act call as a sensitive step: a file upload, an OAuth consent
 * page, typing into or submitting a password/one-time-code/payment field. A
 * download that the call starts is classified after it ran, by the runtime.
 */
const sensitiveStepFor = async (input: {
  readonly args: Record<string, unknown>;
  readonly frames: readonly BrowserAgentFrame[];
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

  if (input.toolName === 'browser_press_key' && targets.length === 0) {
    // A press without an element types into whatever the page has focused.
    const verdict = await classifyFocusedElement(input.session);

    if (verdict.kind === 'plain') {
      return undefined;
    }

    if (verdict.kind === 'unknown') {
      return { origin: input.origin, reason: SENSITIVE_REASON.unknownField };
    }

    if (verdict.frameBackendNodeId === undefined) {
      return { origin: input.origin, reason: verdict.reason };
    }

    // A frame the page cannot read is sensitive by itself; label it with its origin.
    const frameOrigin = await frameOriginForOwner(
      input.session,
      input.frames,
      verdict.frameBackendNodeId
    );

    return { origin: frameOrigin, reason: `typing into a field inside ${frameOrigin}` };
  }

  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop -- one probe per targeted element, in argument order
    const verdict = await classifyTargetElement(input.session, target);

    if (verdict.kind === 'sensitive') {
      return { element: target, origin: input.origin, reason: verdict.reason };
    }

    if (verdict.kind === 'unknown') {
      // A target that cannot be resolved or classified is assumed sensitive.
      return { element: target, origin: input.origin, reason: SENSITIVE_REASON.unknownField };
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

  // `browser_tabs` is one tool over four actions: list filters per tab and select/close are checked by the handler against the group and `act`; only `new` navigates, so it needs the destination's `navigate` grant here.
  if (input.toolName === 'browser_tabs') {
    const destination = navigationOrigin(input.args);

    if (
      argumentString(input.args, 'action') === 'new' &&
      destination !== undefined &&
      !isOriginGranted(input.authorized, 'navigate', destination)
    ) {
      return {
        failure: { items: [{ class: 'navigate', origin: destination }], kind: 'needs_permission' },
        ok: false,
      };
    }

    return { class: 'act', ok: true, origin: destination ?? mainOrigin, targetOriginFrame: false };
  }

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

  // The call is granted: only now spend a DOM read on cardinality. A selector that names several elements cannot run, so it is refused plainly before any sensitive-step ask instead of prompting for a call that would fail.
  for (const text of targetReferencesOf(input.args)) {
    // eslint-disable-next-line no-await-in-loop -- one resolution per reference, in argument order
    const resolved = await input.session.resolveTarget(text);

    if (resolved?.kind === 'ambiguous') {
      return {
        failure: { error: ambiguousSelectorError(resolved.matches), kind: 'blocked' },
        ok: false,
      };
    }
  }

  if (grantClass !== 'act') {
    return { class: grantClass, ok: true, origin, targetOriginFrame };
  }

  const pageUrl = await pageUrlFor(input.session, targetFrame);
  const sensitive = await sensitiveStepFor({
    args: input.args,
    frames,
    origin,
    pageUrl,
    session: input.session,
    toolName: input.toolName,
  });

  if (sensitive === undefined) {
    return { class: grantClass, ok: true, origin, targetOriginFrame };
  }

  if (!isOriginGranted(input.authorized, 'act', sensitive.origin)) {
    return {
      failure: {
        items: [
          {
            class: 'act',
            origin: sensitive.origin,
            ...(sensitive.origin === mainOrigin ? {} : { frame: true }),
          },
        ],
        kind: 'needs_permission',
      },
      ok: false,
    };
  }

  // The approval is labelled with the sensitive element's own frame origin, not the first target's: a password field may live in another frame than the form.
  const sensitiveFrame =
    sensitive.element === undefined
      ? undefined
      : await targetFrameOf(input.session, frames, sensitive.element);
  // A focused cross-origin press carries its own frame origin and no element.
  const sensitiveOrigin =
    sensitive.element === undefined ? sensitive.origin : (sensitiveFrame?.origin ?? origin);
  const sensitiveStep = { ...sensitive, origin: sensitiveOrigin };
  const binding: StepTokenBinding = {
    argumentHash: hashBrowserToolArguments(input.args),
    // The refusal reports the element that probed sensitive; the runtime issues the token for that element, so the retry must bind exactly it.
    element: sensitive.element,
    origin: sensitiveOrigin,
    tabId: input.tabId,
    toolName: input.toolName,
  };
  const matched = input.stepTokens.find(token => input.consumeStepToken(token, binding));

  if (matched !== undefined) {
    return { class: 'act', ok: true, origin, sensitiveToken: matched, targetOriginFrame };
  }

  return {
    failure: {
      items: [{ class: 'sensitive', origin: sensitiveOrigin, reason: sensitive.reason }],
      kind: 'needs_permission',
    },
    ok: false,
    sensitive: sensitiveStep,
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
