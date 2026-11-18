import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ParentSessionLink } from './ParentSessionLink';

Object.assign(globalThis, { React });

describe('ParentSessionLink', () => {
  it('renders parent provenance with a compact mobile label and normal session navigation', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ParentSessionLink, {
        href: '/cloud/chat?sessionId=ses_parent',
        title: 'Investigate login failures',
      })
    );

    expect(markup).toContain('Started from:');
    expect(markup).toContain('href="/cloud/chat?sessionId=ses_parent"');
    expect(markup).toContain('aria-label="View parent session: Investigate login failures"');
    expect(markup).toContain('class="hidden truncate sm:inline"');
    expect(markup).toContain('class="sm:hidden">View parent</span>');
    expect(markup).not.toContain('target="_blank"');
  });

  it('uses a readable fallback for untitled parents and preserves organization routes', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ParentSessionLink, {
        href: '/organizations/org_parent/cloud/chat?sessionId=ses_parent',
        title: null,
      })
    );

    expect(markup).toContain('View parent session: New chat');
    expect(markup).toContain('/organizations/org_parent/cloud/chat?sessionId=ses_parent');
  });

  it('escapes titles as text while retaining the full name for truncated labels', () => {
    const title = '<script>parent</script> ' + 'long workspace title '.repeat(20);
    const markup = renderToStaticMarkup(
      React.createElement(ParentSessionLink, { href: '/cloud/chat?sessionId=ses_parent', title })
    );

    expect(markup).toContain('title="&lt;script&gt;parent&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('truncate');
  });
});
