import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ClawStatusError } from './ClawStatusError';

test('renders the retryable status error with a retry action and the cause', () => {
  const html = renderToStaticMarkup(
    createElement(ClawStatusError, {
      error: new Error('KiloClaw instance status is unavailable'),
      onRetry: () => {},
    })
  );

  expect(html).toContain('Could not load KiloClaw instances');
  expect(html).toContain('KiloClaw instance status is unavailable');
  expect(html).toContain('Try Again');
});

test('still offers the retry action for an error without a message', () => {
  const html = renderToStaticMarkup(
    createElement(ClawStatusError, { error: { unexpected: true }, onRetry: () => {} })
  );

  expect(html).toContain('Could not load KiloClaw instances');
  expect(html).toContain('An unexpected error occurred');
  expect(html).toContain('Try Again');
});
