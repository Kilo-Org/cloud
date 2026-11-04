import { getChatDisplayTitle, keepRealSessionTitle } from './session-title';

describe('getChatDisplayTitle', () => {
  it.each([
    null,
    undefined,
    '',
    '   ',
    'New session - 2026-10-15T21:35:25.332Z',
    'Child session - 2026-10-15T21:35:25.332Z',
  ])('uses a stable name for placeholder %s', title => {
    expect(getChatDisplayTitle(title)).toBe('New chat');
  });
  it.each(['Fix sidebar loading', 'New session - custom task', 'ses_custom_title'])(
    'preserves the user title %s',
    title => {
      expect(getChatDisplayTitle(title)).toBe(title);
    }
  );
});

describe('keepRealSessionTitle', () => {
  const placeholder = 'New session - 2026-10-15T21:35:25.332Z';

  it('keeps a real title when an out-of-order placeholder arrives', () => {
    expect(keepRealSessionTitle('Fix login form validation', placeholder)).toBe(
      'Fix login form validation'
    );
    expect(keepRealSessionTitle('Fix login form validation', null)).toBe(
      'Fix login form validation'
    );
  });

  it('accepts a real title over a placeholder', () => {
    expect(keepRealSessionTitle(placeholder, 'Fix login form validation')).toBe(
      'Fix login form validation'
    );
  });

  it('uses the incoming title when both are placeholders', () => {
    expect(keepRealSessionTitle(placeholder, null)).toBeNull();
    expect(keepRealSessionTitle(null, placeholder)).toBe(placeholder);
  });
});
