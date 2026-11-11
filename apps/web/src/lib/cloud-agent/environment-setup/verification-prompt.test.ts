import { buildVerificationPrompt } from './verification-prompt';

const input = {
  checks: [
    {
      name: 'postgres is reachable',
      command: 'pg_isready -h 127.0.0.1 -p 5432',
      expect: 'exit code 0',
    },
    {
      name: 'web health endpoint',
      command: 'curl -fsS http://localhost:3000/api/health',
      expect: 'HTTP 200 with status ok',
    },
  ],
  workingDirectory: '/workspace/cloud',
};

describe('buildVerificationPrompt', () => {
  it('renders the verification prompt', () => {
    expect(buildVerificationPrompt(input)).toMatchSnapshot();
  });
});
