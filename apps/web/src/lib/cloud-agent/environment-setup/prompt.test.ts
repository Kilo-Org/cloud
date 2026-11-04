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
  networkMode: 'none-or-limited',
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

  it('selects the refinement and network lines', () => {
    const output = buildSetupPrompt({ ...input, isRefinement: true, networkMode: 'full' });

    expect(output).toContain(
      'This run refines an existing environment. The draft starts with its current configuration.'
    );
    expect(output).toContain(
      'Network policy: Full access. Record hosts the environment needs with update_environment_draft requiredHosts.'
    );
    expect(output).not.toContain('This run creates a new environment.');
  });
});
