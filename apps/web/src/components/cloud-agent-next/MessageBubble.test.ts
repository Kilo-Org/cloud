import { getAssistantErrorMessage } from './assistant-error-message';

describe('getAssistantErrorMessage', () => {
  it('returns string runtime assistant errors', () => {
    expect(getAssistantErrorMessage('Assistant request failed')).toBe('Assistant request failed');
  });

  it('returns structured provider error messages', () => {
    expect(getAssistantErrorMessage({ data: { message: 'Provider failed' } })).toBe(
      'Provider failed'
    );
  });

  it('returns top-level error messages', () => {
    expect(getAssistantErrorMessage({ message: 'Wrapper failed' })).toBe('Wrapper failed');
  });
});
