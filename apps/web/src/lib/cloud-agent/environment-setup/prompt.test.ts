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

  it('describes discovery, approval, and restricted verification', () => {
    const output = buildSetupPrompt({ ...input, isRefinement: true });

    expect(output).toContain(
      'This run refines an existing environment. The draft starts with its current configuration.'
    );
    expect(output).toContain('This setup session runs on standard-4');
    expect(output).toContain('The draft starts on standard-3');
    expect(output).toContain('This setup session has full access with auditing');
    expect(output).toContain(
      'request_network_hosts and childSessionId from a verification whose audit denied them'
    );
    expect(output).toContain("Verification sessions use the user's chosen network policy");
    expect(output).toContain('For Full access, record the recommended hosts');
    expect(output).toContain('Keep Full access when the user chose it');
    expect(output).not.toContain('This run creates a new environment.');
  });
});
