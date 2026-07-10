import { maybeInterceptWithSurvey } from '@/lib/survey-redirect';

describe('maybeInterceptWithSurvey', () => {
  it('wraps destination with survey when customer_source is null', () => {
    const user = { customer_source: null };
    expect(maybeInterceptWithSurvey(user, '/get-started')).toBe(
      `/customer-source-survey?callbackPath=${encodeURIComponent('/get-started')}`
    );
  });

  it('preserves complex callback paths', () => {
    const user = { customer_source: null };
    expect(maybeInterceptWithSurvey(user, '/organizations/some-org-id')).toBe(
      `/customer-source-survey?callbackPath=${encodeURIComponent('/organizations/some-org-id')}`
    );
  });

  it('returns destination unchanged when customer_source is a non-empty string', () => {
    const user = { customer_source: 'Twitter' };
    expect(maybeInterceptWithSurvey(user, '/get-started')).toBe('/get-started');
  });

  it('returns destination unchanged when customer_source is empty string (skipped)', () => {
    const user = { customer_source: '' };
    expect(maybeInterceptWithSurvey(user, '/profile')).toBe('/profile');
  });

  it('does not double-wrap if destination is already the survey page', () => {
    const user = { customer_source: null };
    const surveyPath = '/customer-source-survey?callbackPath=%2Fget-started';
    expect(maybeInterceptWithSurvey(user, surveyPath)).toBe(surveyPath);
  });

  it('does not double-wrap bare survey path', () => {
    const user = { customer_source: null };
    expect(maybeInterceptWithSurvey(user, '/customer-source-survey')).toBe(
      '/customer-source-survey'
    );
  });

  it('correctly encodes destinations containing query strings', () => {
    const user = { customer_source: null };
    expect(maybeInterceptWithSurvey(user, '/organizations/abc?tab=billing')).toBe(
      `/customer-source-survey?callbackPath=${encodeURIComponent('/organizations/abc?tab=billing')}`
    );
  });
});
