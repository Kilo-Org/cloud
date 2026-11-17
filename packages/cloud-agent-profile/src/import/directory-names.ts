/** Directory names the import reads, one entry per category. */
export const AGENT_DIRECTORY_NAMES = new Set(['agent', 'agents']);
export const COMMAND_DIRECTORY_NAMES = new Set(['command', 'commands']);
export const SKILLS_DIRECTORY_NAME = 'skills';
export const INSTRUCTIONS_DIRECTORY_NAME = 'instructions';

/** Every category directory name, so a sole top-level one is never stripped as a wrapper. */
export const IMPORT_CATEGORY_DIRECTORY_NAMES = new Set([
  ...AGENT_DIRECTORY_NAMES,
  ...COMMAND_DIRECTORY_NAMES,
  SKILLS_DIRECTORY_NAME,
  INSTRUCTIONS_DIRECTORY_NAME,
]);
