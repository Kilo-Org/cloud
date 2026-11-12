import {
  repositoryAccessTransition,
  repositoryAccessResultMessage,
  repositoryAccessErrorMessage,
} from './repository-access-state';

test.each([
  [undefined, 'read', 'add'],
  ['read', 'contribute', 'increase'],
  ['contribute', 'read', 'reduce'],
  ['read', 'read', 'unchanged'],
  ['contribute', 'remove', 'remove'],
] as const)('maps %s to %s as %s', (current, next, expected) => {
  expect(repositoryAccessTransition(current, next)).toBe(expected);
});
test('explains activation, conflicts, provider read-only access and unavailable authorization', () => {
  expect(repositoryAccessResultMessage(true)).toBe(
    'Access updated. Retry the operation in this workspace.'
  );
  expect(repositoryAccessResultMessage(false)).toContain('another chat');
  expect(repositoryAccessErrorMessage(new Error('repository_read_only'))).toContain('Choose Read');
  expect(repositoryAccessErrorMessage(new Error('authorization_unavailable'))).toContain('Retry');
  expect(repositoryAccessErrorMessage(new Error('secret internal failure'))).not.toContain(
    'secret internal failure'
  );
});
