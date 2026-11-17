jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
    linkingAvailable: true,
    canSharePersonal: false,
    shareableLinks: [],
    sharedWith: [],
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
        status: {
          ...status('not_connected'),
          canSharePersonal: true,
          shareableLinks: [
            {
              payerId: '00000000-0000-4000-8000-000000000009',
              source: {},
              label: 'Personal account',
              connectedAt: '2026-09-16T12:00:00.000Z',
            },
          ],
        },
        scope: 'organization',
        onShare: () => undefined,
      })
    ).toHaveLength(1);
  });

  it('offers no linking action when the release gate omits it', () => {
    expect(buttons({ status: status('not_connected') })).toHaveLength(0);
  });

  it('hides an unlinked card when linking is unavailable', () => {
    expect(render({ status: { ...status('not_connected'), linkingAvailable: false } })).toBe('');
  });

  it('hides the connect action when linking is unavailable', () => {
    expect(
      buttons({
        status: { ...status('not_connected'), linkingAvailable: false },
        onConnect: () => undefined,
      })
    ).toHaveLength(0);
  });

  it('keeps sharing and removal when linking is unavailable', () => {
    const shareable = buttons({
      status: {
        ...status('not_connected'),
        linkingAvailable: false,
        shareableLinks: [
          {
            payerId: '00000000-0000-4000-8000-000000000001',
            source: { organizationId: '00000000-0000-4000-8000-000000000010' },
            label: 'Acme',
            connectedAt: '2026-09-16T12:00:00.000Z',
          },
        ],
      },
      scope: 'personal',
      onConnect: () => undefined,
      onShare: () => undefined,
    });
    expect(shareable.map(button => button.textContent)).toEqual(['Use Claude link from Acme']);

    const connected = buttons({
      status: { ...status('connected'), linkingAvailable: false },
      onConnect: () => undefined,
      onRemove: () => undefined,
    });
    expect(connected.map(button => button.textContent)).toEqual(['Remove from Kilo']);
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

  function render(props: ClaudeBillingCardViewProps): string {
    return renderToStaticMarkup(React.createElement(ClaudeBillingCardView, props));
  }

  it.each([
    ['personal', 'your Claude usage in Kilo'],
    ['organization', "both members' requests and Kilo services such as code review"],
  ] as const)('says what the %s connection bills', (scope, description) => {
    const text = parseHTML(render({ status: status('not_connected'), scope })).document
      .documentElement.textContent;
    expect(text).toContain('Claude (linked billing)');
    expect(text).toContain(description);
  });

  it('states what the organization connection covers', () => {
    const text = parseHTML(render({ status: status('not_connected'), scope: 'organization' }))
      .document.documentElement.textContent;
    expect(text).toContain(
      "Covers every member's Claude requests in this organization and Kilo services such as code review."
    );
  });

  it.each(['personal', 'organization'] as const)(
    'keeps the %s billing terms behind one disclosure',
    scope => {
      const { document } = parseHTML(render({ status: status('not_connected'), scope }));
      const details = document.querySelectorAll('details');
      expect(details).toHaveLength(1);
      expect(details[0].hasAttribute('open')).toBe(false);
      expect(details[0].querySelector('summary')?.textContent).toBe(
        'How Linked billing with Claude Platform works'
      );
      expect(details[0].textContent).toContain('Kilo does not fall back to Kilo credits.');
      expect(details[0].textContent).toContain('owner, admin, or billing admin');
      expect(details[0].textContent).toContain('Claude API organizations only');
      expect(details[0].textContent).toContain(
        'You can set a monthly spend limit for Kilo when you link'
      );
      expect(details[0].textContent).toContain('credits from Anthropic partner, VC, or startup');
      expect(details[0].textContent).toContain('and billing members when Kilo is linked');
      expect(details[0].textContent).toContain('data retention settings do not apply');
    }
  );

  it.each([
    ['linked_organization_spend_limit_reached', 'A Claude spend limit was reached'],
    ['linked_organization_billing_unavailable', 'Anthropic cannot bill your Claude organization'],
    ['billing_error', 'Anthropic cannot bill your Claude organization'],
  ] as const)('explains the %s refusal', (code, copy) => {
    expect(render({ status: { ...status('connected'), lastRefusalCode: code } })).toContain(copy);
  });

  it('points an unavailable link at Linked platforms in Claude Console', () => {
    expect(render({ status: status('billing_unavailable') })).toContain(
      'Check Linked platforms in Claude Console, link it again if needed'
    );
  });

  it('shows a status badge only once a link exists', () => {
    expect(render({ status: status('not_connected') })).not.toContain('Not linked');
    expect(render({ status: status('connected') })).toContain('>Linked<');
    expect(render({ status: status('billing_unavailable') })).toContain('Billing unavailable');
  });

  it('reports a link that needs linking again and offers the owner the action', () => {
    const html = render({
      status: { ...status('reconnect_required'), connectedAt: '2026-09-16T12:00:00.000Z' },
      scope: 'organization',
      onConnect: () => undefined,
      onRemove: () => undefined,
    });
    const { document } = parseHTML(html);

    expect(html).toContain('New link required');
    expect(html).not.toContain('>Linked<');
    expect(html).toContain('is no longer available');
    expect(
      buttons({
        status: status('reconnect_required'),
        scope: 'organization',
        onConnect: () => undefined,
      }).map(button => button.textContent)
    ).toEqual(['Link Claude billing again', 'Remove from Kilo']);
    expect(document.querySelectorAll('button')).toHaveLength(2);
  });

  it('shows the link-again state to a member without the action', () => {
    const html = render({
      status: { ...status('reconnect_required'), canManage: false },
      scope: 'organization',
    });
    expect(html).toContain('New link required');
    expect(html).toContain('is no longer available');
    expect(html).toContain('Ask a Kilo organization owner or admin to link a Claude organization.');
  });

  it.each(['not_connected', 'connected'] as const)(
    'keeps the Claude Console link outside the disclosure when %s',
    state => {
      const { document } = parseHTML(render({ status: status(state) }));
      const links = Array.from(document.querySelectorAll('a'));
      expect(links).toHaveLength(1);
      expect(links[0].textContent).toBe(
        'Set a spend limit or unlink under Linked platforms in Claude Console'
      );
      expect(links[0].getAttribute('href')).toBe('https://platform.claude.com/linked-platforms');
      expect(links[0].closest('details')).toBeNull();
    }
  );

  it('explains what removing an existing link does', () => {
    const { document } = parseHTML(render({ status: status('connected') }));
    expect(document.querySelector('details')?.textContent).toContain('Removing the link from Kilo');
  });

  it('offers an organization link on an unlinked personal card', () => {
    const rendered = buttons({
      status: {
        ...status('not_connected'),
        shareableLinks: [
          {
            payerId: '00000000-0000-4000-8000-000000000001',
            source: { organizationId: '00000000-0000-4000-8000-000000000010' },
            label: 'Acme',
            connectedAt: '2026-09-16T12:00:00.000Z',
          },
        ],
      },
      scope: 'personal',
      onConnect: () => undefined,
      onShare: () => undefined,
    });
    expect(rendered.map(button => button.textContent)).toEqual([
      'Link your Claude organization',
      'Use Claude link from Acme',
    ]);
  });

  it('renders a link selector when multiple Claude accounts are available', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClaudeBillingCardView, {
        status: {
          ...status('not_connected'),
          shareableLinks: [
            {
              payerId: '00000000-0000-4000-8000-000000000001',
              source: { organizationId: '00000000-0000-4000-8000-000000000010' },
              label: 'Acme',
              connectedAt: '2026-09-16T12:00:00.000Z',
            },
            {
              payerId: '00000000-0000-4000-8000-000000000002',
              source: {},
              label: 'Personal account',
              connectedAt: '2026-09-16T12:00:00.000Z',
            },
          ],
        },
        scope: 'organization',
        onConnect: () => undefined,
        onShare: () => undefined,
      })
    );
    const doc = parseHTML(html).document;
    const selectTrigger = doc.querySelector('[aria-label="Existing Claude link"]');
    expect(selectTrigger?.textContent).toContain('Acme');
    expect(html).toContain('Use selected Claude link');
  });

  it('displays shared scopes on a connected card', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClaudeBillingCardView, {
        status: {
          ...status('connected'),
          sharedWith: ['Personal account', 'Acme'],
        },
        scope: 'organization',
        onConnect: () => undefined,
      })
    );
    expect(html).toContain('Shared with Personal account, Acme.');
  });
});
