import { resolveConnectionErrorMessage } from '@/components/integrations/connection-error-message';

const messages: Record<string, string> = {
  permission_required: 'Only owners and admins can change this.',
  organization_access_required: 'You do not have access to this organization.',
};

const fallback = 'Connection failed: unknown_code';

describe('resolveConnectionErrorMessage', () => {
  it('returns the mapped message for a code the map defines', () => {
    expect(resolveConnectionErrorMessage(messages, 'permission_required', fallback)).toBe(
      'Only owners and admins can change this.'
    );
  });

  it('returns the fallback for a code the map does not define', () => {
    expect(resolveConnectionErrorMessage(messages, 'unknown_code', fallback)).toBe(fallback);
  });

  it('returns the fallback for keys that only the object prototype defines', () => {
    for (const code of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const message = resolveConnectionErrorMessage(messages, code, fallback);

      expect(message).toBe(fallback);
      expect(typeof message).toBe('string');
    }
  });
});
