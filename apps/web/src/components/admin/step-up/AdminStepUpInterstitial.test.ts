import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('./StepUpDialog', () => ({
  StepUpDialog: (props: { open: boolean; dismissible?: boolean; requirement: unknown }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'dialog',
        'data-open': String(props.open),
        'data-dismissible': String(props.dismissible),
        'data-code': (props.requirement as { code: string }).code,
      },
      null
    ),
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
    expect(markup).toContain('data-open="true"');
    expect(markup).toContain('data-dismissible="false"');
    expect(markup).toContain('data-code="MFA_REQUIRED"');
  });
});
