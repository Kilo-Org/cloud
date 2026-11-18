import { readableSessionError } from './session-error-copy';

describe('readableSessionError', () => {
  it.each([
    ['workspace_setup_failed', 'Workspace setup failed'],
    ['workspace_snapshot_start_failed', 'Workspace snapshot could not be restored'],
    ['environment_snapshot_required', 'Sandbox could not start from the environment snapshot'],
    [' git_authentication_failed ', 'Repository authentication failed'],
  ])('maps the bare code %j to its sentence', (code, sentence) => {
    expect(readableSessionError(code)).toBe(sentence);
  });

  it.each(['Workspace setup failed: sandbox storage full', 'Session not found', 'failed'])(
    'keeps the readable message %j unchanged',
    message => {
      expect(readableSessionError(message)).toBe(message);
    }
  );
});
