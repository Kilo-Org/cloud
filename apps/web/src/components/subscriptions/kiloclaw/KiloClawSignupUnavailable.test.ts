import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';
import { KiloClawSignupUnavailable } from './KiloClawSignupUnavailable';

describe('KiloClawSignupUnavailable', () => {
  it('explains the closure without rendering a signup action', () => {
    const markup = renderToStaticMarkup(React.createElement(KiloClawSignupUnavailable));

    expect(markup).toContain('New KiloClaw instances are unavailable');
    expect(markup).toContain('A current KiloClaw subscription is required');
    expect(markup).toContain('Existing instances and subscriptions continue as normal.');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a');
  });
});
