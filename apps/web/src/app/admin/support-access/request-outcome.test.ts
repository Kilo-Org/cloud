import { afterAll, describe, expect, it } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportRequestOutcomeNotice, supportRequestOutcome } from './request-outcome';

const previousReact = Reflect.get(globalThis, 'React');
Reflect.set(globalThis, 'React', React);

describe('supportRequestOutcome', () => {
  it('links to the organization for an active read grant', () => {
    const outcome = supportRequestOutcome({
      actionClass: 'support_read',
      status: 'active',
      organizationId: 'org-1',
      organizationName: 'Customer Org',
    });

    expect(outcome.kind).toBe('read-active');
    expect(outcome.message).toContain('Customer Org');

    const html = renderToStaticMarkup(createElement(SupportRequestOutcomeNotice, { outcome }));

    expect(html).toContain('href="/organizations/org-1"');
    expect(html).toContain('Open organization');
    expect(html).toContain('Customer Org');
  });

  it('does not describe a non-active read request as a write request', () => {
    const outcome = supportRequestOutcome({
      actionClass: 'support_read',
      status: 'pending',
      organizationId: 'org-1',
      organizationName: 'Customer Org',
    });

    expect(outcome.kind).toBe('notice');
    expect(outcome.message).toContain('requested but is not active');
    expect(outcome.message).not.toContain('Write access request');

    const html = renderToStaticMarkup(createElement(SupportRequestOutcomeNotice, { outcome }));

    expect(html).not.toContain('Open organization');
    expect(html).not.toContain('/organizations/org-1');
  });

  it('describes a pending write request without an open link', () => {
    const outcome = supportRequestOutcome({
      actionClass: 'support_write',
      status: 'pending',
      organizationId: 'org-1',
      organizationName: 'Customer Org',
    });

    expect(outcome.kind).toBe('notice');
    expect(outcome.message).toContain("second admin's approval");
    expect(outcome.message).toContain('30 minutes');

    const html = renderToStaticMarkup(createElement(SupportRequestOutcomeNotice, { outcome }));

    expect(html).not.toContain('Open organization');
    expect(html).not.toContain('/organizations/org-1');
  });
});

afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});
