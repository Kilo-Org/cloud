import { renderToStaticMarkup } from 'react-dom/server';
import { GitHubConnectionAttemptState } from './GitHubConnectionAttemptState';

const baseProps = {
  isLoading: false,
  isSelecting: false,
  isRestarting: false,
  onSelect: () => {},
  onRestart: () => {},
};

test('shows restart rather than empty-result copy when the attempt failed', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState {...baseProps} isError candidates={undefined} />
  );
  expect(html).toContain('expired or is no longer available');
  expect(html).toContain('Restart connection');
  expect(html).not.toContain('No eligible existing GitHub installations');
});

test('shows empty-result copy only after a successful empty result', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionAttemptState {...baseProps} isError={false} candidates={[]} />
  );
  expect(html).toContain('No eligible existing GitHub installations were found');
  expect(html).not.toContain('Restart connection');
});
