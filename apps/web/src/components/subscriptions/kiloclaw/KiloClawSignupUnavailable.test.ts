import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';
import { KiloClawSignupUnavailable } from './KiloClawSignupUnavailable';

describe('KiloClawSignupUnavailable', () => {
  it('explains the closure without rendering a signup action', () => {
    const markup = renderToStaticMarkup(React.createElement(KiloClawSignupUnavailable));

    expect(markup).toContain('New KiloClaw subscriptions are unavailable');
    expect(markup).toContain('Existing subscriptions continue as normal.');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a');
  });
});
