import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('./StepUpDialog', () => ({
  StepUpCeremonyContent: (props: { dismissible?: boolean; requirement: unknown }) =>
    React.createElement('div', {
      'data-testid': 'ceremony',
      'data-dismissible': String(props.dismissible),
      'data-code': (props.requirement as { code: string }).code,
    }),
}));

import type { AdminStepUpInterstitial as InterstitialComponent } from './AdminStepUpInterstitial';

let AdminStepUpInterstitial!: typeof InterstitialComponent;

beforeAll(async () => {
  ({ AdminStepUpInterstitial } = await import('./AdminStepUpInterstitial'));
});

describe('AdminStepUpInterstitial', () => {
  it('renders a non-dismissible verification dialog with the requirement', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AdminStepUpInterstitial, {
        requirement: { code: 'MFA_REQUIRED' },
      })
    );

    expect(markup).toContain('Verify it is you');
    expect(markup).toContain('data-dismissible="false"');
    expect(markup).toContain('data-code="MFA_REQUIRED"');
  });
});
