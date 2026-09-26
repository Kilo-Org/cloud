/**
 * Pure form helpers for the mobile profile manager.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `agent-profile-forms.test.ts` and mirrors the server-side
 * validation the `agentProfiles.*` procedures apply, so the mobile form can
 * reject invalid input before it reaches the API.
 */

/** Server bound: `ProfileNameSchema`'s `z.string().min(1).max(100)`. */
const PROFILE_NAME_MAX_LENGTH = 100;

/** Server bound: `ProfileDescriptionSchema`'s `z.string().max(500)`. */
const PROFILE_DESCRIPTION_MAX_LENGTH = 500;

/** Server bound: `VarSchema`'s `z.string().min(1).max(256)`. */
export const VARIABLE_KEY_MAX_LENGTH = 256;

/**
 * Server bound: the inline session layer's env-var values. The prepare-session
 * input caps each value at 256 characters (`cloud-agent-next-schemas.ts`'s
 * `envVars` record), which is stricter than a profile's own `VarSchema`
 * (10000), so the manual editor under Advanced Configuration applies this
 * bound where the profile editor does not.
 */
export const MAX_SESSION_ENV_VAR_VALUE_LENGTH = 256;

/** Server pattern: `profile-skills-service.ts`'s `SKILL_NAME_PATTERN`. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type ProfileNameError = 'empty' | 'too-long';

/**
 * Validate a profile name. Names are trimmed, matching the server's
 * `min(1)` after the form trims. Returns an error code, or `null` when valid.
 */
export function validateProfileName(value: string): ProfileNameError | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'empty';
  }
  if (trimmed.length > PROFILE_NAME_MAX_LENGTH) {
    return 'too-long';
  }
  return null;
}

export type ProfileDescriptionError = 'too-long';

/**
 * Validate a profile description against the server's `max(500)`. Descriptions
 * are trimmed first, matching the form's trim on submit. Returns an error code,
 * or `null` when valid.
 */
export function validateProfileDescription(value: string): ProfileDescriptionError | null {
  return value.trim().length > PROFILE_DESCRIPTION_MAX_LENGTH ? 'too-long' : null;
}

/**
 * Parse frontmatter `name` and `description` out of a SKILL.md body.
 * Ported from the web editor's minimal parser
 * (`apps/web/src/components/cloud-agent/profile-editor/SkillsTab.tsx`): only a
 * leading `---` block, only these two fields, quotes stripped.
 */
export type SkillFrontmatter = { name?: string; description?: string };

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/.exec(markdown);
  if (!match) {
    return {};
  }
  const frontmatter = match[1] ?? '';
  const nameMatch = /^name\s*:\s*(.+)$/m.exec(frontmatter);
  const descriptionMatch = /^description\s*:\s*(.+)$/m.exec(frontmatter);
  return {
    name: nameMatch?.[1] === undefined ? undefined : stripQuotes(nameMatch[1]),
    description: descriptionMatch?.[1] === undefined ? undefined : stripQuotes(descriptionMatch[1]),
  };
}

export type SkillInputError = 'empty' | 'bad-name' | 'no-content';

export type SkillInputValidation = { error: SkillInputError | null; description?: string };

/**
 * Validate a pasted custom skill. The name is checked against the server's
 * pattern; when the content carries frontmatter, its `description` is returned
 * so the caller can pass it through.
 */
export function validateSkillInput(input: { name: string; content: string }): SkillInputValidation {
  const name = input.name.trim();
  if (name.length === 0) {
    return { error: 'empty' };
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { error: 'bad-name' };
  }
  if (input.content.trim().length === 0) {
    return { error: 'no-content' };
  }
  const { description } = parseSkillFrontmatter(input.content);
  return description === undefined ? { error: null } : { error: null, description };
}

/**
 * Normalize a typed environment variable key to the shape the server stores:
 * upper case, with anything outside `A-Z0-9_` replaced by `_`. Matches the web
 * editor's `cleanKey`.
 */
export function cleanVariableKey(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_');
}

/** A key is valid when its trimmed length is within the server's 1..256 bound. */
export function isValidVariableKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= VARIABLE_KEY_MAX_LENGTH;
}

/** Server bound: each setup command is at most 500 characters. */
export const MAX_SETUP_COMMAND_LENGTH = 500;

/** Server bound: a profile or session accepts at most 20 setup commands. */
export const MAX_SETUP_COMMANDS = 20;

/**
 * Append a blank setup command for the user to type into. The server caps the
 * list at `MAX_SETUP_COMMANDS` (`CommandsSchema`'s
 * `z.array(z.string().max(500)).max(20)`), so at the cap the list is returned
 * unchanged rather than producing a payload the server would reject.
 */
export function addCommand(commands: readonly string[]): string[] {
  if (commands.length >= MAX_SETUP_COMMANDS) {
    return [...commands];
  }
  return [...commands, ''];
}

/** Replace the command at `index`. Out-of-range indices leave the list intact. */
export function replaceCommand(
  commands: readonly string[],
  index: number,
  value: string
): string[] {
  return commands.map((command, current) => (current === index ? value : command));
}

/** Remove the command at `index`. Out-of-range indices leave the list intact. */
export function removeCommand(commands: readonly string[], index: number): string[] {
  return commands.filter((_, current) => current !== index);
}

/**
 * Move the command at `index` by `delta` positions (`-1` up, `+1` down),
 * clamped to the list's edges, returning a new array. The screen sends the
 * whole ordered list to `setCommands`, so order is the only state.
 */
export function moveCommand(commands: readonly string[], index: number, delta: number): string[] {
  if (index < 0 || index >= commands.length) {
    return [...commands];
  }
  const target = Math.max(0, Math.min(commands.length - 1, index + delta));
  if (target === index) {
    return [...commands];
  }
  const next = [...commands];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) {
    return [...commands];
  }
  next.splice(target, 0, moved);
  return next;
}
