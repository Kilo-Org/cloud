import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnavailablePinnedGitHubInstallation } from './GitHubRepositorySelector';

describe('GitHubRepositorySelector', () => {
  it('shows an actionable warning for an unavailable saved installation', () => {
    const html = renderToStaticMarkup(
      createElement(UnavailablePinnedGitHubInstallation, {
        selection: {
          repository: 'acme/api',
          platformIntegrationId: '11111111-1111-4111-8111-111111111111',
          platformAccountLogin: 'acme',
        },
        integrationsPath: '/organizations/org-1/integrations',
      })
    );

    expect(html).toContain('Saved GitHub installation unavailable');
    expect(html).toContain('the acme installation');
    expect(html).toContain('acme/api');
    expect(html).toContain('href="/organizations/org-1/integrations"');
    expect(html).toContain('Review GitHub integrations');
  });
});
