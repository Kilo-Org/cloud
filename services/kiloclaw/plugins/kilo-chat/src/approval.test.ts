import { describe, expect, it } from 'vitest';
import { createKiloChatApprovalCapability } from './approval.js';
import { editMessageRequestSchema } from './synced/schemas.js';

const validConversationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function getNativeRuntime() {
  const runtime = createKiloChatApprovalCapability().nativeRuntime;
  if (!runtime) throw new Error('Expected native runtime');
  return runtime;
}

describe('createKiloChatApprovalCapability', () => {
  const capability = createKiloChatApprovalCapability();

  it('returns a capability with authorizeActorAction always authorized', () => {
    expect(capability.authorizeActorAction).toBeDefined();
    const result = capability.authorizeActorAction!({
      cfg: {} as never,
      action: 'approve',
      approvalKind: 'exec',
    });
    expect(result).toEqual({ authorized: true });
  });

  it('returns a capability with getActionAvailabilityState always enabled', () => {
    expect(capability.getActionAvailabilityState).toBeDefined();
    const result = capability.getActionAvailabilityState!({
      cfg: {} as never,
      action: 'approve',
    });
    expect(result).toEqual({ kind: 'enabled' });
  });

  it('has native adapter describing delivery capabilities', () => {
    expect(capability.native).toBeDefined();
    const caps = capability.native!.describeDeliveryCapabilities({
      cfg: {} as never,
      approvalKind: 'exec',
      request: { id: 'a1', request: {}, createdAtMs: 0, expiresAtMs: 0 } as never,
    });
    expect(caps.enabled).toBe(true);
    expect(caps.preferredSurface).toBe('origin');
    expect(caps.supportsOriginSurface).toBe(true);
    expect(caps.supportsApproverDmSurface).toBe(false);
  });

  it('resolveOriginTarget extracts conversationId from session key', () => {
    // Session keys built by the SDK are lowercased, so use a lowercase key.
    const target = capability.native!.resolveOriginTarget!({
      cfg: {} as never,
      approvalKind: 'exec',
      request: {
        id: 'a1',
        request: { sessionKey: 'agent:main:direct:01hwxyz123abc456def789gh' },
        createdAtMs: 0,
        expiresAtMs: 0,
      } as never,
    });
    expect(target).toEqual({ to: '01HWXYZ123ABC456DEF789GH' });
  });

  it('resolveOriginTarget returns null when sessionKey is absent', () => {
    const target = capability.native!.resolveOriginTarget!({
      cfg: {} as never,
      approvalKind: 'exec',
      request: {
        id: 'a1',
        request: {},
        createdAtMs: 0,
        expiresAtMs: 0,
      } as never,
    });
    expect(target).toBeNull();
  });

  it('resolveOriginTarget returns null when sessionKey has no direct segment', () => {
    const target = capability.native!.resolveOriginTarget!({
      cfg: {} as never,
      approvalKind: 'exec',
      request: {
        id: 'a1',
        request: { sessionKey: 'agent:main:group:some-group' },
        createdAtMs: 0,
        expiresAtMs: 0,
      } as never,
    });
    expect(target).toBeNull();
  });

  it('has nativeRuntime with availability always configured and handling', () => {
    expect(capability.nativeRuntime).toBeDefined();
    const rt = capability.nativeRuntime!;
    expect(rt.availability.isConfigured({} as never)).toBe(true);
    expect(rt.availability.shouldHandle({} as never)).toBe(true);
  });

  it('has nativeRuntime with exec and plugin event kinds', () => {
    expect(capability.nativeRuntime!.eventKinds).toEqual(['exec', 'plugin']);
  });

  it('has render adapter for exec approvals', () => {
    expect(capability.render).toBeDefined();
    expect(capability.render!.exec).toBeDefined();
    expect(capability.render!.exec!.buildPendingPayload).toBeDefined();
    expect(capability.render!.exec!.buildResolvedPayload).toBeDefined();
  });

  it('has render adapter for plugin approvals', () => {
    expect(capability.render!.plugin).toBeDefined();
    expect(capability.render!.plugin!.buildPendingPayload).toBeDefined();
    expect(capability.render!.plugin!.buildResolvedPayload).toBeDefined();
  });

  it('suppresses forwarding fallback when target channel is kilo-chat', () => {
    expect(capability.delivery).toBeDefined();
    const suppress = capability.delivery!.shouldSuppressForwardingFallback!;
    expect(
      suppress({
        cfg: {} as never,
        approvalKind: 'exec',
        target: { channel: 'kilo-chat', to: 'conv-1' },
        request: { request: {} },
      } as never)
    ).toBe(true);
  });

  it('does not suppress forwarding fallback for other channels', () => {
    const suppress = capability.delivery!.shouldSuppressForwardingFallback!;
    expect(
      suppress({
        cfg: {} as never,
        approvalKind: 'exec',
        target: { channel: 'slack', to: 'target-1' },
        request: { request: {} },
      } as never)
    ).toBe(false);
  });

  it('does not edit Kilo Chat again when the final approval payload is resolved', async () => {
    const rt = getNativeRuntime();
    const result = rt.presentation.buildResolvedResult({
      view: {
        approvalKind: 'plugin',
        approvalId: 'approval-1',
        title: 'Deploy change',
        description: 'Deploy the proposed change',
        metadata: [],
        decision: 'deny',
        resolvedBy: 'user-1',
      },
    } as never);
    expect(result.action).toBe('update');

    const fetchCalls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      fetchCalls.push({ input, init });
      return new Response(JSON.stringify({ messageId: 'msg-1' }));
    };
    const originalFetch = globalThis.fetch;
    const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    globalThis.fetch = fetchImpl;
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
    try {
      await rt.transport.updateEntry({
        entry: {
          messageId: 'msg-1',
          conversationId: validConversationId,
          approvalId: 'approval-1',
        },
        payload: result.payload,
      } as never);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalGatewayToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
      }
    }

    expect(fetchCalls).toHaveLength(0);
  });

  it('builds expired approval edits that match the canonical edit payload schema', () => {
    const rt = getNativeRuntime();
    const result = rt.presentation.buildExpiredResult({
      view: {
        approvalKind: 'plugin',
        approvalId: 'approval-1',
        title: 'Deploy change',
        description: 'Deploy the proposed change',
        metadata: [],
      },
    } as never);
    expect(result.action).toBe('update');

    const parsed = editMessageRequestSchema.safeParse({
      conversationId: validConversationId,
      content: result.payload,
      timestamp: 1,
    });

    expect(parsed.success).toBe(true);
  });
});
