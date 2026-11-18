/* eslint-disable max-lines -- one preflight case per grant, sensitive-step and redirect branch */
/* eslint-disable require-await -- a fake CDP channel is async by contract */
import { describe, expect, it } from 'vitest';
import {
  createStepTokenStore,
  hashBrowserToolArguments,
  SENSITIVE_REASON,
} from './browser-agent-checks';
import type { BrowserGrant, StepTokenStore } from './browser-agent-checks';
import { postAgentNavigate, preflightAgentCall } from './browser-agent-gate';
import type { AgentPreflight } from './browser-agent-gate';
import type { BrowserToolResolvedTarget } from './browser-tool-session';

type CdpHandler = (
  params: Record<string, unknown> | undefined
) => Record<string, unknown> | undefined;

const failureOf = (result: AgentPreflight) => (result.ok ? undefined : result.failure);

const sensitiveOf = (result: AgentPreflight) => (result.ok ? undefined : result.sensitive);

const sensitiveReasonOf = (result: AgentPreflight) => sensitiveOf(result)?.reason;

/** Node 12 is the pay frame's field; every other node lives in the main frame. */
const frameIdForTestNode = (backendNodeId: number): string =>
  backendNodeId === 12 ? 'f1' : 'main';

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
    readonly describeNodeFails?: boolean;
    readonly focusedNodeName?: string;
    readonly forbidQuerySelectorAll?: boolean;
    readonly fieldProbeFailureFrames?: readonly string[];
    readonly frameOwnerFailsFor?: readonly string[];
    readonly nestedPathBackendIds?: readonly number[];
    readonly nestedFrames?: readonly {
      readonly frameId: string;
      readonly ownerBackendNodeId: number;
      readonly parentId?: string;
      readonly securityOrigin: string;
      readonly url: string;
    }[];
    readonly frameIdForBackendNode?: (backendNodeId: number) => string;
    readonly mainUrl?: string;
    readonly presentFieldFrames?: readonly string[];
    readonly probe?: Record<string, unknown>;
    readonly probeByObject?: Record<string, Record<string, unknown>>;
    readonly ambiguousSelectors?: Record<string, number>;
    readonly selectors?: Record<string, { readonly frameId: string; readonly nodeId: number }>;
    readonly targetFrameId?: string;
  } = {}
): FakeGateSession => {
  let describeObjectCalls = 0;
  // One isolated world per frame, so the field-presence probe can tell the frames apart.
  const worlds = new Map<number, string>();
  let nextContextId = 9;

  const handlers: Record<string, CdpHandler> = {
    'DOM.describeNode': params => {
      if (options.describeNodeFails === true) {
        return;
      }

      if (params?.['nodeId'] !== undefined) {
        const { nodeId } = params;
        const selector = Object.values(options.selectors ?? {}).find(
          entry => entry.nodeId === nodeId
        );

        return { node: { backendNodeId: 40, frameId: selector?.frameId ?? 'main' } };
      }

      if (params?.['objectId'] !== undefined) {
        const backendNodeId = options.nestedPathBackendIds?.[describeObjectCalls] ?? 40;
        describeObjectCalls += 1;

        return { node: { backendNodeId, nodeName: options.focusedNodeName ?? 'INPUT' } };
      }

      const backendNodeId = params?.['backendNodeId'];
      const frameId =
        typeof backendNodeId === 'number'
          ? (options.frameIdForBackendNode?.(backendNodeId) ?? options.targetFrameId ?? 'main')
          : (options.targetFrameId ?? 'main');

      return { node: { frameId } };
    },
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.getFrameOwner': params => {
      const requested = params?.['frameId'];
      const frameId = typeof requested === 'string' ? requested : '';

      if (options.frameOwnerFailsFor?.includes(frameId) === true) {
        throw new Error(`no owner for ${frameId}`);
      }

      return {
        backendNodeId:
          options.nestedFrames?.find(frame => frame.frameId === frameId)?.ownerBackendNodeId ?? 40,
      };
    },
    'DOM.querySelectorAll': () => {
      if (options.forbidQuerySelectorAll === true) {
        throw new Error('index lookup must not identify a frame');
      }

      return { nodeIds: [30] };
    },
    'DOM.resolveNode': params => {
      const id = params?.['backendNodeId'] ?? params?.['nodeId'];

      return { object: { objectId: `obj-${String(id)}` } };
    },
    'Page.createIsolatedWorld': params => {
      const frameId = typeof params?.['frameId'] === 'string' ? params['frameId'] : 'main';
      const executionContextId = nextContextId;

      nextContextId += 1;
      worlds.set(executionContextId, frameId);

      return { executionContextId };
    },
    'Page.getFrameTree': () => {
      const nested = options.nestedFrames;

      if (nested === undefined) {
        return frameTree(options.mainUrl ?? MAIN_URL);
      }

      return {
        frameTree: {
          childFrames: nested
            .filter(frame => frame.parentId === undefined)
            .map(frame => ({
              childFrames: nested
                .filter(child => child.parentId === frame.frameId)
                .map(child => ({
                  frame: {
                    id: child.frameId,
                    parentId: frame.frameId,
                    securityOrigin: child.securityOrigin,
                    url: child.url,
                  },
                })),
              frame: {
                id: frame.frameId,
                parentId: frame.parentId ?? 'main',
                securityOrigin: frame.securityOrigin,
                url: frame.url,
              },
            })),
          frame: { id: 'main', securityOrigin: 'https://app.example.com', url: MAIN_URL },
        },
      };
    },
    'Runtime.callFunctionOn': params => {
      const objectId = params?.['objectId'];
      const probeForObject =
        typeof objectId === 'string' ? options.probeByObject?.[objectId] : undefined;

      return {
        result: {
          value: JSON.stringify(
            probeForObject ?? options.probe ?? { fields: [], paymentFormSubmit: false }
          ),
        },
      };
    },
    'Runtime.evaluate': params => {
      const expression = typeof params?.['expression'] === 'string' ? params['expression'] : '';

      if (!expression.includes('present')) {
        return { result: { objectId: 'obj-focused' } };
      }

      const contextId = params?.['contextId'];
      const frameId = typeof contextId === 'number' ? (worlds.get(contextId) ?? 'main') : 'main';

      if (options.fieldProbeFailureFrames?.includes(frameId) === true) {
        // No value: the probe could not run in this frame.
        return { result: {} };
      }

      return {
        result: {
          value: JSON.stringify({ present: options.presentFieldFrames?.includes(frameId) === true }),
        },
      };
    },
  };

  return {
    resolveTarget: async (target: string) => {
      const matches = options.ambiguousSelectors?.[target];

      if (matches !== undefined) {
        return { kind: 'ambiguous', matches, selector: target };
      }

      const selector = options.selectors?.[target];

      if (selector !== undefined) {
        return { kind: 'selector', nodeId: selector.nodeId, selector: target };
      }

      return target.startsWith('e') && Number.isInteger(Number(target.slice(1)))
        ? { backendNodeId: Number(target.slice(1)), kind: 'ref', ref: target }
        : undefined;
    },
    send: async (method, params) => {
      const handler = handlers[method];

      if (handler === undefined) {
        throw new Error(`unexpected CDP method ${method}`);
      }

      return handler(params);
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
    expect(failureOf(result)).toStrictEqual({
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
      args: { target: 'e12' },
      authorized: grants.filter(grant => grant.origin === 'https://app.example.com'),
      session: createSession({ targetFrameId: 'f1' }),
      toolName: 'browser_click',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'https://pay.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('allows an act inside a granted frame and marks it as a frame target', async () => {
    const result = await run({
      args: { target: 'e12' },
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

  it('requires act for every fill_form field frame, not only the tab origin', async () => {
    const result = await run({
      args: {
        fields: [
          { name: 'Card', target: 'e12', type: 'textbox', value: '4111' },
          { name: 'Name', target: 'e13', type: 'textbox', value: 'Igor' },
        ],
      },
      authorized: [
        { class: 'act', origin: 'https://app.example.com' },
        { class: 'read', origin: 'https://pay.example.com' },
      ],
      session: createSession({ frameIdForBackendNode: frameIdForTestNode }),
      toolName: 'browser_fill_form',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'https://pay.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('refuses a target whose frame cannot be read', async () => {
    const result = await run({
      args: { target: 'e12' },
      session: createSession({ describeNodeFails: true }),
      toolName: 'browser_click',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'opaque:null' }],
      kind: 'needs_permission',
    });
  });

  it('requires act for both ends of a drag', async () => {
    const result = await run({
      args: { endTarget: 'e12', startTarget: 'e13' },
      authorized: [{ class: 'act', origin: 'https://app.example.com' }],
      session: createSession({ frameIdForBackendNode: frameIdForTestNode }),
      toolName: 'browser_drag',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'https://pay.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('gates browser_tabs new on the destination origin', async () => {
    const result = await run({
      args: { action: 'new', url: 'https://evil.example.net/login' },
      toolName: 'browser_tabs',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'navigate', origin: 'https://evil.example.net' }],
      kind: 'needs_permission',
    });
  });

  it('lets a tabs list through without act on the current origin', async () => {
    const result = await run({
      args: { action: 'list' },
      authorized: [],
      toolName: 'browser_tabs',
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('gates a navigate on the destination origin, not the current one', async () => {
    const refused = await run({
      args: { url: 'https://evil.example.net/login' },
      toolName: 'browser_navigate',
    });

    expect(failureOf(refused)).toStrictEqual({
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

    await expect(
      postAgentNavigate(createSession({ mainUrl: approved }), approved)
    ).resolves.toBeUndefined();
    await expect(
      postAgentNavigate(createSession({ mainUrl: 'https://accounts.example.org/login' }), approved)
    ).resolves.toStrictEqual({
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
      args: { target: 'e12', text: 'hunter2' },
      probe: passwordProbe,
      toolName: 'browser_type',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.password,
        },
      ],
      kind: 'needs_permission',
    });
    expect(sensitiveOf(result)).toStrictEqual({
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
    });
  });

  it('refuses filling a password field without a step token', async () => {
    const result = await run({
      args: {
        fields: [{ name: 'Password', target: 'e12', type: 'textbox', value: 'hunter2' }],
      },
      probe: passwordProbe,
      toolName: 'browser_fill_form',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.password,
        },
      ],
      kind: 'needs_permission',
    });
    expect(sensitiveOf(result)).toStrictEqual({
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
    });
  });

  it('binds the token to the sensitive element, not the first target', async () => {
    const tokens = createStepTokenStore({ now: () => 1000, random: () => 'token-d' });
    const args = {
      fields: [
        { name: 'Name', target: 'e11', type: 'textbox', value: 'Igor' },
        { name: 'Password', target: 'e12', type: 'textbox', value: 'hunter2' },
      ],
    };
    const session = createSession({ probeByObject: { 'obj-12': passwordProbe } });
    const refused = await run({ args, session, toolName: 'browser_fill_form' }, tokens);

    expect(failureOf(refused)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.password,
        },
      ],
      kind: 'needs_permission',
    });
    expect(sensitiveOf(refused)).toStrictEqual({
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
    });

    // The runtime issues the token for the element the refusal reports.
    const token = tokens.issue({
      argumentHash: hashBrowserToolArguments(args),
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
      tabId: 7,
      toolName: 'browser_fill_form',
    });
    const allowed = await run(
      { args, session, stepTokens: [token], toolName: 'browser_fill_form' },
      tokens
    );

    expect(allowed).toMatchObject({ ok: true, sensitiveToken: token });

    const replay = await run(
      { args, session, stepTokens: [token], toolName: 'browser_fill_form' },
      tokens
    );

    expect(replay.ok).toBe(false);
  });

  it('probes the focused element for a press without a target', async () => {
    const result = await run({
      args: { key: 'Enter' },
      session: createSession({ probe: passwordProbe }),
      toolName: 'browser_press_key',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.password,
        },
      ],
      kind: 'needs_permission',
    });
  });

  it('labels the approval with the sensitive element\u2019s own frame origin', async () => {
    const passwords = { 'obj-12': passwordProbe };
    const result = await run({
      args: {
        fields: [
          { name: 'Name', target: 'e11', type: 'textbox', value: 'Igor' },
          { name: 'Password', target: 'e12', type: 'textbox', value: 'hunter2' },
        ],
      },
      session: createSession({
        frameIdForBackendNode: frameIdForTestNode,
        probeByObject: passwords,
      }),
      toolName: 'browser_fill_form',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://pay.example.com',
          reason: SENSITIVE_REASON.password,
        },
      ],
      kind: 'needs_permission',
    });
    expect(sensitiveOf(result)).toStrictEqual({
      element: 'e12',
      origin: 'https://pay.example.com',
      reason: SENSITIVE_REASON.password,
    });
  });

  it('fails closed when the focus chain enters a cross-origin frame', async () => {
    const session = createSession({ focusedNodeName: 'IFRAME' });
    const refusedGrant = await run({
      args: { key: 'Enter' },
      authorized: [{ class: 'act', origin: 'https://app.example.com' }],
      session,
      toolName: 'browser_press_key',
    });

    expect(failureOf(refusedGrant)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'https://pay.example.com' }],
      kind: 'needs_permission',
    });

    const refusedStep = await run({
      args: { key: 'Enter' },
      session,
      toolName: 'browser_press_key',
    });

    // With the frame granted the step is still sensitive, labelled with that frame.
    expect(sensitiveOf(refusedStep)).toStrictEqual({
      origin: 'https://pay.example.com',
      reason: 'typing into a field inside https://pay.example.com',
    });
  });

  it('classifies a selector that names a password field', async () => {
    const result = await run({
      args: { target: '#pw' },
      session: createSession({
        probeByObject: { 'obj-5': passwordProbe },
        selectors: { '#pw': { frameId: 'main', nodeId: 5 } },
      }),
      toolName: 'browser_type',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.password,
        },
      ],
      kind: 'needs_permission',
    });
    expect(sensitiveOf(result)).toStrictEqual({
      element: '#pw',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
    });
  });

  it('asks for the frame origin of a selector inside an iframe', async () => {
    const result = await run({
      args: { target: '#frame-field' },
      authorized: [{ class: 'act', origin: 'https://app.example.com' }],
      session: createSession({
        selectors: { '#frame-field': { frameId: 'f1', nodeId: 6 } },
      }),
      toolName: 'browser_type',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'https://pay.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('runs a unique target even when the element description matches several', async () => {
    const result = await run({
      args: { element: 'button', target: '#unique' },
      session: createSession({
        ambiguousSelectors: { button: 3 },
        selectors: { '#unique': { frameId: 'main', nodeId: 7 } },
      }),
      toolName: 'browser_click',
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('asks for the grant before it discloses an ambiguous selector', async () => {
    const result = await run({
      args: { target: '#many' },
      authorized: [{ class: 'act', origin: 'https://other.example.com' }],
      session: createSession({ ambiguousSelectors: { '#many': 3 } }),
      toolName: 'browser_click',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', origin: 'https://app.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('refuses an ambiguous selector before asking for any permission', async () => {
    const result = await run({
      args: { target: '#many' },
      session: createSession({ ambiguousSelectors: { '#many': 3 } }),
      toolName: 'browser_click',
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      failure: {
        error:
          'The selector matches 3 elements. Use a snapshot ref or a selector that matches one element.',
        kind: 'blocked',
      },
    });
    // A call that cannot run never becomes a permission ask.
    expect(failureOf(result)).not.toHaveProperty('items');
  });

  it('counts a selector that resolves nothing as sensitive', async () => {
    const result = await run({
      args: { target: '#ambiguous' },
      toolName: 'browser_type',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.unknownField,
        },
      ],
      kind: 'needs_permission',
    });
  });

  it('counts a target it cannot probe as sensitive', async () => {
    const result = await run({
      args: { target: 'zz' },
      toolName: 'browser_click',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        {
          class: 'sensitive',
          origin: 'https://app.example.com',
          reason: SENSITIVE_REASON.unknownField,
        },
      ],
      kind: 'needs_permission',
    });
    expect(sensitiveOf(result)).toStrictEqual({
      element: 'zz',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.unknownField,
    });
  });

  it('names the frame from the focused element handle, not a page index', async () => {
    const result = await run({
      args: { key: 'Enter' },
      authorized: [{ class: 'act', origin: 'https://app.example.com' }],
      session: createSession({
        focusedNodeName: 'IFRAME',
        forbidQuerySelectorAll: true,
        nestedFrames: [
          {
            frameId: 'f1',
            ownerBackendNodeId: 40,
            securityOrigin: 'https://pay.example.com',
            url: 'https://pay.example.com/widget',
          },
          {
            frameId: 'f2',
            ownerBackendNodeId: 41,
            parentId: 'f1',
            securityOrigin: 'https://inner.example.org',
            url: 'https://inner.example.org/form',
          },
        ],
        nestedPathBackendIds: [41],
      }),
      toolName: 'browser_press_key',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'https://inner.example.org' }],
      kind: 'needs_permission',
    });
  });

  it('keeps the other frames\u2019 origins when one owner lookup fails', async () => {
    const result = await run({
      args: { key: 'Enter' },
      authorized: [{ class: 'act', origin: 'https://app.example.com' }],
      session: createSession({
        focusedNodeName: 'IFRAME',
        frameOwnerFailsFor: ['f1'],
        nestedFrames: [
          {
            frameId: 'f1',
            ownerBackendNodeId: 50,
            securityOrigin: 'https://broken.example.com',
            url: 'https://broken.example.com/',
          },
          {
            frameId: 'f2',
            ownerBackendNodeId: 41,
            securityOrigin: 'https://other.example.com',
            url: 'https://other.example.com/form',
          },
        ],
        nestedPathBackendIds: [41],
      }),
      toolName: 'browser_press_key',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [{ class: 'act', frame: true, origin: 'https://other.example.com' }],
      kind: 'needs_permission',
    });
  });

  it('allows the retry that carries the binding token, then burns it', async () => {
    const tokens = createStepTokenStore({ now: () => 1000, random: () => 'token-b' });
    const args = { target: 'e12', text: 'hunter2' };
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
      argumentHash: hashBrowserToolArguments({ target: 'e12', text: 'other' }),
      element: 'e12',
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.password,
      tabId: 7,
      toolName: 'browser_type',
    });

    const result = await run(
      {
        args: { target: 'e12', text: 'hunter2' },
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
      args: { target: 'e12' },
      probe: { fields: [], paymentFormSubmit: true },
      toolName: 'browser_click',
    });

    expect(sensitiveReasonOf(result)).toBe(SENSITIVE_REASON.cardFormSubmit);
  });

  it('classifies an OAuth consent page as sensitive', async () => {
    const result = await run({
      args: { target: 'e12' },
      authorized: [
        ...grants,
        { class: 'act', origin: 'https://accounts.google.com' },
        { class: 'read', origin: 'https://accounts.google.com' },
      ],
      session: createSession({ mainUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }),
      toolName: 'browser_click',
    });

    expect(sensitiveReasonOf(result)).toBe(SENSITIVE_REASON.oauthConsent);
  });

  it('classifies a file upload as sensitive', async () => {
    const result = await run({
      args: { paths: ['/tmp/receipt.pdf'] },
      toolName: 'browser_file_upload',
    });

    expect(sensitiveReasonOf(result)).toBe(SENSITIVE_REASON.fileUpload);
  });

  it('leaves an ordinary text field alone', async () => {
    const result = await run({
      args: { target: 'e12', text: 'igor@example.com' },
      probe: { fields: [], paymentFormSubmit: false },
      toolName: 'browser_type',
    });

    expect(result.ok).toBe(true);
  });
});

describe('script calls', () => {
  it('refuses browser_evaluate when a readable frame holds a protected field', async () => {
    const result = await run({
      session: createSession({ presentFieldFrames: ['main'] }),
      toolName: 'browser_evaluate',
    });

    expect(failureOf(result)).toStrictEqual({
      items: [
        { class: 'sensitive', origin: 'https://app.example.com', reason: SENSITIVE_REASON.script },
      ],
      kind: 'needs_permission',
    });
    expect(sensitiveReasonOf(result)).toBe(SENSITIVE_REASON.script);
  });

  it('runs browser_evaluate when no readable frame holds a protected field', async () => {
    const result = await run({ toolName: 'browser_evaluate' });

    expect(result).toMatchObject({ class: 'act', ok: true });
  });

  it('classifies a readable cross-origin frame that holds a card field', async () => {
    const result = await run({
      session: createSession({ presentFieldFrames: ['f1'] }),
      toolName: 'browser_run_code_unsafe',
    });

    expect(sensitiveReasonOf(result)).toBe(SENSITIVE_REASON.script);
  });

  it('ignores a frame the CLI may not read', async () => {
    const result = await run({
      authorized: [
        { class: 'act', origin: 'https://app.example.com' },
        { class: 'read', origin: 'https://app.example.com' },
      ],
      session: createSession({ presentFieldFrames: ['f1'] }),
      toolName: 'browser_evaluate',
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('fails closed when a readable frame cannot be inspected', async () => {
    const result = await run({
      session: createSession({ fieldProbeFailureFrames: ['main'] }),
      toolName: 'browser_evaluate',
    });

    expect(sensitiveReasonOf(result)).toBe(SENSITIVE_REASON.scriptUnverified);
  });

  it('allows the retry that carries the token bound to the script call', async () => {
    const tokens = createStepTokenStore({ now: () => 1000, random: () => 'token-s' });
    const args = { function: '() => document.body.innerText' };
    const token = tokens.issue({
      argumentHash: hashBrowserToolArguments(args),
      origin: 'https://app.example.com',
      reason: SENSITIVE_REASON.script,
      tabId: 7,
      toolName: 'browser_evaluate',
    });
    const session = createSession({ presentFieldFrames: ['main'] });
    const result = await run(
      { args, session, stepTokens: [token], toolName: 'browser_evaluate' },
      tokens
    );

    expect(result).toMatchObject({ ok: true, sensitiveToken: token });

    const replay = await run(
      { args, session, stepTokens: [token], toolName: 'browser_evaluate' },
      tokens
    );

    expect(replay.ok).toBe(false);
  });
});
