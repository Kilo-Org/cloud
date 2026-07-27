import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from '@jest/globals';
import { ProviderAttribution } from '@/components/organizations/providers-and-models/ProviderAttribution';
import { PolicyPill } from '@/components/organizations/providers-and-models/PolicyPills';

describe('endpoint policy presentation', () => {
  test('shows the endpoint provider, routing provider, and retention duration', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ProviderAttribution, {
          providerDisplayName: 'Claude Platform on AWS',
          routingProviderDisplayName: 'Amazon Bedrock',
        }),
        React.createElement(PolicyPill, {
          value: true,
          variant: 'retainsPrompts',
          retentionDays: 30,
        })
      )
    );

    expect(html).toContain('Claude Platform on AWS');
    expect(html).toContain('via Amazon Bedrock');
    expect(html).toContain('30 days');
  });
});
