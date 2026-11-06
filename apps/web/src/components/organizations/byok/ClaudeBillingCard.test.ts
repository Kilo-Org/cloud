jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  CLAUDE_BILLING_PROVIDER_ID,
  CLAUDE_BILLING_PROVIDER_NAME,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import { ClaudeBillingCardView, type ClaudeBillingCardViewProps } from './ClaudeBillingCard';
import type { ClaudeBillingStatus } from '@/routers/claude-billing-router';

const originalReact = Object.getOwnPropertyDescriptor(globalThis, 'React');
beforeAll(() => {
  Object.defineProperty(globalThis, 'React', { configurable: true, writable: true, value: React });
});
afterAll(() => {
  if (originalReact) Object.defineProperty(globalThis, 'React', originalReact);
  else Reflect.deleteProperty(globalThis, 'React');
});

function status(state: ClaudeBillingStatus['state']): ClaudeBillingStatus {
  return {
    state,
    connectedAt: state === 'connected' ? '2026-09-16T12:00:00.000Z' : null,
    lastRefusalCode: null,
    providerId: CLAUDE_BILLING_PROVIDER_ID,
    providerName: CLAUDE_BILLING_PROVIDER_NAME,
    canManage: true,
  };
}

function render(props: ClaudeBillingCardViewProps): string {
  return renderToStaticMarkup(React.createElement(ClaudeBillingCardView, props));
}

describe('ClaudeBillingCardView', () => {
  it('offers connect for a new connection', () => {
    const html = render({ status: status('not_connected'), onConnect: () => undefined });
    expect(html).toContain('Connect your Claude organization');
    expect(html).not.toContain('Remove from Kilo');
  });

  it('offers reconnect beside removal for an existing connection', () => {
    const html = render({
      status: status('connected'),
      onConnect: () => undefined,
      onRemove: () => undefined,
    });
    expect(html).toContain('Reconnect your Claude organization');
    expect(html).toContain('Remove from Kilo');
  });

  it('directs read-only members to an owner without offering connection controls', () => {
    const html = render({
      status: { ...status('connected'), canManage: false },
      onConnect: () => undefined,
    });
    expect(html).toContain('Ask a Kilo organization owner or admin');
    expect(html).not.toContain('Remove from Kilo');
    expect(html).not.toContain('Reconnect your Claude organization');
  });
});
