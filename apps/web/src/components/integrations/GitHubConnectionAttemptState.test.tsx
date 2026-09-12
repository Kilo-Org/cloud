import { renderToStaticMarkup } from 'react-dom/server';
import { GitHubConnectionAttemptState } from './GitHubConnectionAttemptState';

const baseProps = {
  isLoading: false,
  isNotFound: false,
  isSelecting: false,
  isRestarting: false,
  onSelect: () => {},
  onRestart: () => {},
  onRetry: () => {},
  canInstallNew: false,
  onInstallNew: () => {},
  isInstalling: false,
};

test('shows restart rather than empty-result copy when the attempt is confirmed not found', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState {...baseProps} isError isNotFound candidates={undefined} />
  );
  expect(html).toContain('expired or is no longer available');
  expect(html).toContain('Restart connection');
  expect(html).not.toContain('No existing GitHub installations are available');
  expect(html).not.toContain('Could not load this connection attempt');
});

test('shows a retry, not an expired claim, for a non-not-found error', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState
      {...baseProps}
      isError
      isNotFound={false}
      candidates={undefined}
    />
  );
  expect(html).toContain('Could not load this connection attempt');
  expect(html).toContain('Try again');
  expect(html).not.toContain('expired or is no longer available');
  expect(html).not.toContain('Restart connection');
});

test('shows empty-result copy only after a successful empty result', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState
      {...baseProps}
      isError={false}
      isNotFound={false}
      candidates={[]}
    />
  );
  expect(html).toContain('No existing GitHub installations are available to connect');
  expect(html).not.toContain('Restart connection');
});

test('offers installing on a different org even when no attachable installation was found', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState {...baseProps} isError={false} candidates={[]} canInstallNew />
  );
  expect(html).toContain('Install on a different GitHub organization');
  expect(html).toContain('Install the GitHub App to grant Kilo access');
});

test('hides the install-new option when a fresh install is not currently permitted', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState
      {...baseProps}
      isError={false}
      candidates={[]}
      canInstallNew={false}
    />
  );
  expect(html).not.toContain('Install on a different GitHub organization');
});

test('surfaces attachable installations alongside the install-new option', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState
      {...baseProps}
      isError={false}
      candidates={[
        { installationId: '111', accountLogin: 'acme' },
        { installationId: '222', accountLogin: 'widgets-inc' },
      ]}
      canInstallNew
    />
  );
  expect(html).toContain('acme');
  expect(html).toContain('widgets-inc');
  expect(html).toContain('Install on a different GitHub organization');
});

test('does not offer install-new alongside candidates when a fresh install is not permitted', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState
      {...baseProps}
      isError={false}
      candidates={[{ installationId: '111', accountLogin: 'acme' }]}
      canInstallNew={false}
    />
  );
  expect(html).toContain('acme');
  expect(html).not.toContain('Install on a different GitHub organization');
});

test('gives each candidate button an accessible name beyond the bare account login', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState
      {...baseProps}
      isError={false}
      candidates={[{ installationId: '111', accountLogin: 'acme' }]}
    />
  );
  expect(html).toContain('aria-label="Connect acme, installation 111"');
});
