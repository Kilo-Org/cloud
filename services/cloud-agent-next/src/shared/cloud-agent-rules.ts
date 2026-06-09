export function buildCloudAgentRules(sessionId: string): string {
  return [
    '# Cloud Agent Environment',
    '',
    "You are running inside a sandboxed cloud container, not on the user's local machine.",
    'The filesystem is ephemeral and will not persist after the session ends.',
    "Do not assume access to the user's local files, browsers, or desktop environment.",
    '',
    '## Temporary Files',
    '',
    `When you need to create temporary or scratch files, use \`/tmp/${sessionId}/\` as your scratch directory.`,
    'This path is pre-approved for file access and will not trigger permission prompts.',
    '',
    '## Command Execution',
    '',
    'Always set a timeout of no more than two minutes for each command.',
    'Avoid commands that are likely to exceed this limit, especially repository-wide lint, typecheck, or type-generation commands in large repositories. Prefer focused commands scoped to the changed files or relevant package.',
    'If a command cannot finish within two minutes or its failure cannot be fixed quickly, stop retrying the command and continue without it.',
    'Report any validation that you could not run or complete.',
    '',
  ].join('\n');
}
