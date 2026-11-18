import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnstileView } from './TurnstileView';

const mockTurnstile = jest.fn((_props: unknown) => null);

jest.mock('react-turnstile', () => (props: unknown) => mockTurnstile(props));

describe('TurnstileView discovery state', () => {
  it('disables Back while post-Turnstile discovery is in progress', () => {
    const html = renderToStaticMarkup(
      createElement(TurnstileView, {
        turnstileError: false,
        isVerifying: true,
        attemptId: 0,
        onSuccess: () => undefined,
        onError: () => undefined,
        onRetry: () => undefined,
        onBack: () => undefined,
        backButtonText: 'sign in options',
      })
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('← Back to sign in options');
  });

  it('keeps the verification view stable while automatic magic-link delivery is pending', () => {
    const html = renderToStaticMarkup(
      createElement(TurnstileView, {
        turnstileError: false,
        isVerifying: true,
        isDeliveringMagicLink: true,
        attemptId: 0,
        onSuccess: () => undefined,
        onError: () => undefined,
        onRetry: () => undefined,
      })
    );

    expect(html).toContain('Sending magic link...');
    expect(html).toContain('role="status"');
  });

  it('announces verification failure and retry guidance', () => {
    const html = renderToStaticMarkup(
      createElement(TurnstileView, {
        turnstileError: true,
        isVerifying: false,
        attemptId: 0,
        onSuccess: () => undefined,
        onError: () => undefined,
        onRetry: () => undefined,
      })
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('Security verification failed. Please try again.');
    expect(html).toContain('Try Again');
  });

  it('reports errors with the rendered Turnstile attempt ID', () => {
    const onError = jest.fn();
    renderToStaticMarkup(
      createElement(TurnstileView, {
        turnstileError: false,
        isVerifying: false,
        attemptId: 42,
        onSuccess: () => undefined,
        onError,
        onRetry: () => undefined,
      })
    );

    const turnstileProps = mockTurnstile.mock.calls.at(-1)?.[0] as {
      onError: () => void;
    };
    turnstileProps.onError();

    expect(onError).toHaveBeenCalledWith(42);
  });
});
