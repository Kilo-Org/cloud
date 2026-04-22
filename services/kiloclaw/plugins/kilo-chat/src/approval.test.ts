import { describe, expect, it } from 'vitest';
import { createKiloChatApprovalCapability } from './approval.js';

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
});
