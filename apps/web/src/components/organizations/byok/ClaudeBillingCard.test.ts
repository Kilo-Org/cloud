jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('posthog-js/react', () => ({
  useFeatureFlagEnabled: () => false,
}));

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
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
    canSharePersonal: false,
  };
}

function buttons(props: ClaudeBillingCardViewProps): HTMLButtonElement[] {
  const html = renderToStaticMarkup(React.createElement(ClaudeBillingCardView, props));
  return Array.from(parseHTML(html).document.querySelectorAll('button'));
}

describe('ClaudeBillingCardView', () => {
  it('offers the linking action for an unlinked owner when supplied', () => {
    expect(buttons({ status: status('not_connected'), onConnect: () => undefined })).toHaveLength(
      1
    );
  });

  it('offers the personal-link action for an unlinked organization scope', () => {
    expect(
      buttons({
        status: { ...status('not_connected'), canSharePersonal: true },
        scope: 'member',
        onShare: () => undefined,
      })
    ).toHaveLength(1);
  });

  it('offers no linking action when the release gate omits it', () => {
    expect(buttons({ status: status('not_connected') })).toHaveLength(0);
  });

  it('retains removal when an existing link has no linking action', () => {
    expect(buttons({ status: status('connected'), onRemove: () => undefined })).toHaveLength(1);
  });

  it('offers linking again and removal for an existing link', () => {
    expect(
      buttons({
        status: status('connected'),
        onConnect: () => undefined,
        onRemove: () => undefined,
      })
    ).toHaveLength(2);
  });

  it('hides linking and removal controls from read-only members', () => {
    expect(buttons({ status: { ...status('connected'), canManage: false } })).toHaveLength(0);
  });

  it.each([
    ['personal', 'Linked billing with Claude Platform'],
    ['member', 'Linked billing with Claude Platform'],
    ['shared_services', 'Claude billing for shared services'],
  ] as const)('names the %s connection it shows', (scope, title) => {
    const html = renderToStaticMarkup(
      React.createElement(ClaudeBillingCardView, {
        status: status('not_connected'),
        scope,
      })
    );
    expect(html).toContain(title);
  });
});
