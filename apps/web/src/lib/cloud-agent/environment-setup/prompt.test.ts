import { buildSetupPrompt, type SetupPromptInput } from './prompt';

const input = {
  requirements:
    'Set up the local dev stack. Use the fake login.\nRun the migrations before the tests.',
  repositories: [
    { repoFullName: 'Kilo-Org/cloud', path: '/workspace/cloud' },
    { repoFullName: 'Kilo-Org/design', path: '/workspace/design' },
  ],
  workingDirectory: '/workspace',
  isRefinement: false,
} satisfies SetupPromptInput;

describe('buildSetupPrompt', () => {
  it('renders the setup prompt', () => {
    expect(buildSetupPrompt(input)).toMatchSnapshot();
  });

  it('keeps the requirements only between the markers', () => {
    const output = buildSetupPrompt(input);
    const markerStart = '<<<REQUIREMENTS\n';
    const markerEnd = '\nREQUIREMENTS>>>';
    const start = output.indexOf(markerStart);
    const end = output.indexOf(markerEnd);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(output.slice(start + markerStart.length, end)).toBe(input.requirements);
    expect(output.split(input.requirements)).toHaveLength(2);
  });

  it('refines existing environments without requesting network hosts', () => {
    const output = buildSetupPrompt({ ...input, isRefinement: true });
    expect(output).toContain('This run refines an existing environment.');
    expect(output).toContain('This setup session runs on standard-4');
    expect(output).toContain('The draft starts on standard-3');
    expect(output).toContain('Leave the existing network policy unchanged.');
    expect(output).not.toContain('request_network_hosts');
    expect(output).not.toContain('requiredHosts');
    expect(output).not.toContain('This run creates a new environment.');
  });

  it.each(['', '   '])('chooses a useful repository setup without guidance: %j', requirements => {
    const output = buildSetupPrompt({ ...input, requirements });
    expect(output).toContain('No guidance was provided. Inspect the repositories');
    expect(output).toContain('prepare a useful development environment for the user.');
    expect(output).toContain('verify_environment_draft');
  });
});
