/* eslint-disable require-await -- a fake CDP channel is async by contract */
import { describe, expect, it } from 'vitest';
import {
  createStepTokenStore,
  hashBrowserToolArguments,
  SENSITIVE_REASON,
} from './browser-agent-checks';
import type { BrowserGrant, StepTokenStore } from './browser-agent-checks';
import { postAgentNavigate, preflightAgentCall } from './browser-agent-gate';
import type { BrowserToolResolvedTarget } from './browser-tool-session';

type CdpHandler = (params: Record<string, unknown> | undefined) => unknown;

const MAIN_URL = 'https://app.example.com/dashboard';
const FRAME_URL = 'https://pay.example.com/widget';

interface FakeGateSession {
  readonly send: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown> | undefined>;
  readonly resolveTarget: (target: string) => Promise<BrowserToolResolvedTarget | undefined>;
  readonly takeDownloads: () => readonly never[];
}

const frameTree = (mainUrl: string): Record<string, unknown> => ({
  frameTree: {
    childFrames: [
      {
        frame: {
          id: 'f1',
          parentId: 'main',
          securityOrigin: 'https://pay.example.com',
          url: FRAME_URL,
        },
      },
    ],
    frame: { id: 'main', securityOrigin: 'https://app.example.com', url: mainUrl },
  },
});

const createSession = (
  options: {
    readonly mainUrl?: string;
    readonly probe?: Record<string, unknown>;
    readonly targetFrameId?: string;
  } = {}
): FakeGateSession => {
  const handlers: Record<string, CdpHandler> = {
    'DOM.describeNode': () => ({ node: { frameId: options.targetFrameId ?? 'main' } }),
    'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
    'Page.getFrameTree': () => frameTree(options.mainUrl ?? MAIN_URL),
    'Runtime.callFunctionOn': () => ({
      result: {
        value: JSON.stringify(options.probe ?? { fields: [], paymentFormSubmit: false }),
      },
    }),
  };

  return {
    resolveTarget: async (target: string) =>
      target.startsWith('e') ? { backendNodeId: 12, kind: 'ref', ref: target } : undefined,
    send: async (method, params) => {
      const handler = handlers[method];

      if (handler === undefined) {
        throw new Error(`unexpected CDP method ${method}`);
      }

      const value = handler(params);

      return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    },
    takeDownloads: () => [],
  };
};

const grants: readonly BrowserGrant[] = [
  { class: 'read', origin: 'https://app.example.com' },
  { class: 'act', origin: 'https://app.example.com' },
  { class: 'read', origin: 'https://pay.example.com' },
  { class: 'act', origin: 'https://pay.example.com' },
];

const run = (
  input: {
    readonly args?: Record<string, unknown>;
    readonly authorized?: readonly BrowserGrant[];
    readonly probe?: Record<string, unknown>;
    readonly session?: FakeGateSession;
    readonly stepTokens?: readonly string[];
    readonly toolName: string;
  },
  tokens: StepTokenStore = createStepTokenStore({
    now: () => 1000,
    random: () => 'token-a',
  })
) =>
  preflightAgentCall({
    args: input.args ?? {},
    authorized: input.authorized ?? grants,
    consumeStepToken: (token, binding) => tokens.consume(token, binding),
    session:
      input.session ?? createSession(input.probe === undefined ? {} : { probe: input.probe }),
    stepTokens: input.stepTokens ?? [],
    tabId: 7,
    toolName: input.toolName,
  });

describe('origin grants', () => {
  it('refuses a read on an origin the CLI did not approve', async () => {
    const result = await run({
      authorized: [{ class: 'act', origin: 'https://app.example.com' }],
      toolName: 'browser_snapshot',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.failure : undefined).toEqual({
      items: [{ class: 'read', origin: 'https://app.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('allows a read the CLI approved', async () => {
    const result = await run({ toolName: 'browser_snapshot' });

    expect(result).toMatchObject({
      class: 'read',
      ok: true,
      origin: 'https://app.example.com',
      targetOriginFrame: false,
    });
  });

  it('asks for the frame origin when a ref lives inside an iframe', async () => {
    const result = await run({
      args: { element: 'e12' },
      authorized: grants.filter(grant => grant.origin === 'https://app.example.com'),
      session: createSession({ targetFrameId: 'f1' }),
      toolName: 'browser_click',
    });

    expect(result.ok === false ? result.failure : undefined).toEqual({
      items: [{ class: 'act', frame: true, origin: 'https://pay.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('allows an act inside a granted frame and marks it as a frame target', async () => {
    const result = await run({
      args: { element: 'e12' },
      session: createSession({ targetFrameId: 'f1' }),
      toolName: 'browser_click',
    });

    expect(result).toMatchObject({
      class: 'act',
      ok: true,
      origin: 'https://pay.example.com',
      targetOriginFrame: true,
    });
  });

  it('gates a navigate on the destination origin, not the current one', async () => {
    const refused = await run({
      args: { url: 'https://evil.example.net/login' },
      toolName: 'browser_navigate',
    });

    expect(refused.ok === false ? refused.failure : undefined).toEqual({
      items: [{ class: 'navigate', origin: 'https://evil.example.net' }],
      kind: 'needs_permission',
    });

    const allowed = await run({
      args: { url: 'https://other.example.com/home' },
      authorized: [...grants, { class: 'navigate', origin: 'https://other.example.com' }],
      toolName: 'browser_navigate',
    });

    expect(allowed).toMatchObject({ ok: true, origin: 'https://other.example.com' });
  });
});

describe('origin changed after redirects', () => {
  it('reports the origin a navigation landed on', async () => {
    const approved = 'https://other.example.com';

    expect(await postAgentNavigate(createSession({ mainUrl: approved }), approved)).toBeUndefined();
    expect(
      await postAgentNavigate(
        createSession({ mainUrl: 'https://accounts.example.org/login' }),
        approved
      )
    ).toEqual({
      from: approved,
      kind: 'origin_changed',
      to: 'https://accounts.example.org',
    });
  });
});

describe('sensitive steps', () => {
  const passwordProbe = { fields: [{ kind: 'password' }], paymentFormSubmit: false };

  it('refuses typing a password without a step token', async () => {
    const result = await run({
      args: { element: 'e12', text: 'hunter2' },
      probe: passwordProbe,
      toolName: 'browser_type',
    });

    expect(result.ok === false ? result.failure : undefined).toEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.password,
        },
      ],
      kind: 'needs_permission',
    });
    expect(result.ok === false ? result.sensitive : undefined).toEqual({
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
    });
  });

  it('allows the retry that carries the binding token, then burns it', async () => {
    const tokens = createStepTokenStore({ now: () => 1000, random: () => 'token-b' });
    const args = { element: 'e12', text: 'hunter2' };
    const token = tokens.issue({
      argumentHash: hashBrowserToolArguments(args),
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
      tabId: 7,
      toolName: 'browser_type',
    });

    const result = await run(
      { args, probe: passwordProbe, stepTokens: [token], toolName: 'browser_type' },
      tokens
    );

    expect(result).toMatchObject({ ok: true, sensitiveToken: token });

    const replay = await run(
      { args, probe: passwordProbe, stepTokens: [token], toolName: 'browser_type' },
      tokens
    );

    expect(replay.ok).toBe(false);
  });

  it('refuses a token issued for other arguments', async () => {
    const tokens = createStepTokenStore({ now: () => 1000, random: () => 'token-c' });
    const token = tokens.issue({
      argumentHash: hashBrowserToolArguments({ element: 'e12', text: 'other' }),
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
      tabId: 7,
      toolName: 'browser_type',
    });

    const result = await run(
      {
        args: { element: 'e12', text: 'hunter2' },
        probe: passwordProbe,
        stepTokens: [token],
        toolName: 'browser_type',
      },
      tokens
    );

    expect(result.ok).toBe(false);
  });

  it('classifies a submit inside a card form', async () => {
    const result = await run({
      args: { element: 'e12' },
      probe: { fields: [], paymentFormSubmit: true },
      toolName: 'browser_click',
    });

    expect(result.ok === false ? result.sensitive?.reason : undefined).toBe(
      SENSITIVE_REASON.cardFormSubmit
    );
  });

  it('classifies an OAuth consent page as sensitive', async () => {
    const result = await run({
      args: { element: 'e12' },
      authorized: [
        ...grants,
        { class: 'act', origin: 'https://accounts.google.com' },
        { class: 'read', origin: 'https://accounts.google.com' },
      ],
      session: createSession({ mainUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }),
      toolName: 'browser_click',
    });

    expect(result.ok === false ? result.sensitive?.reason : undefined).toBe(
      SENSITIVE_REASON.oauthConsent
    );
  });

  it('classifies a file upload as sensitive', async () => {
    const result = await run({
      args: { paths: ['/tmp/receipt.pdf'] },
      toolName: 'browser_file_upload',
    });

    expect(result.ok === false ? result.sensitive?.reason : undefined).toBe(
      SENSITIVE_REASON.fileUpload
    );
  });

  it('leaves an ordinary text field alone', async () => {
    const result = await run({
      args: { element: 'e12', text: 'igor@example.com' },
      probe: { fields: [], paymentFormSubmit: false },
      toolName: 'browser_type',
    });

    expect(result.ok).toBe(true);
  });
});
