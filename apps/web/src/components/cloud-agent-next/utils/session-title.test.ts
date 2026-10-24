import { getChatDisplayTitle } from './session-title';

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
