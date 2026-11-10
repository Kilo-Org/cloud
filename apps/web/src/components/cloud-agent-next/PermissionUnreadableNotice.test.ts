import { describe, expect, it } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PermissionUnreadableNotice } from './PermissionUnreadableNotice';

describe('PermissionUnreadableNotice', () => {
  it('announces a waiting permission request the app cannot show', () => {
    const html = renderToStaticMarkup(createElement(PermissionUnreadableNotice));

    expect(html).toContain('role="alert"');
    expect(html).toContain('Permission request could not be read');
    expect(html).toContain('The agent is waiting for a permission decision this app cannot show.');
    expect(html).toContain('answer the request in the CLI');
  });

  it('offers no consent action for a request whose scope was not read', () => {
    const html = renderToStaticMarkup(createElement(PermissionUnreadableNotice));

    expect(html).not.toContain('<button');
    expect(html).not.toContain('Allow Once');
    expect(html).not.toContain('Always Allow');
  });
});
