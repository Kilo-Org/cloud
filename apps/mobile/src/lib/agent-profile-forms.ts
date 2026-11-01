/**
 * Pure form helpers for the mobile profile manager.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `agent-profile-forms.test.ts` and mirrors the server-side
 * validation the `agentProfiles.*` procedures apply, so the mobile form can
 * reject invalid input before it reaches the API.
 */

import { foldForSearch } from '@/i18n/fold-for-search';

/** Server bound: `agent-profiles-router.ts`'s `name: z.string().min(1).max(100)`. */
export const PROFILE_NAME_MAX_LENGTH = 100;

/** Server bound: `agent-profiles-router.ts`'s `description: z.string().max(500)`. */
export const PROFILE_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Server bound: the profile variable key contract, mirrored from
 * `ENVIRONMENT_LIMITS.MAX_KEY_LENGTH` in
 * `packages/cloud-agent-profile/src/environment-contracts.ts`.
 */
export const VARIABLE_KEY_MAX_LENGTH = 128;

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

/** Server bound: `contracts/skills.ts`'s `MAX_SKILL_NAME_LENGTH`. */
export const SKILL_NAME_MAX_LENGTH = 100;

/**
 * Server rule: `environment-contracts.ts`'s reserved names and prefixes. A key
 * the sandbox runtime owns is refused when a profile stores it, so the form
 * refuses it before the request. The form stores keys upper-cased, and the
 * package list holds one lower-case name (`pnpm_config_store_dir`) that no
 * upper-cased key can equal, so that name is left out rather than refusing a
 * key the package accepts.
 */
const RESERVED_VARIABLE_KEY_NAMES: ReadonlySet<string> = new Set([
  'HOME',
  'SESSION_ID',
  'SESSION_HOME',
  'SANDBOX_CONTROL_CREDENTIAL',
  'SANDBOX_CONTROL_URL',
  'PROVIDER_INSTANCE_ID',
  'CONTROL_LOG_UPLOAD_URL',
  'CONTROL_LOG_UPLOAD_GRANT',
  'CONTROL_WRAPPER_INSTANCE_ID',
]);

const RESERVED_VARIABLE_KEY_PREFIXES = ['XDG_', 'KILO', 'OPENCODE'] as const;

/** Whether the sandbox runtime owns this key. */
export function isReservedVariableKey(key: string): boolean {
  const stored = key.toUpperCase();
  return (
    RESERVED_VARIABLE_KEY_NAMES.has(stored) ||
    RESERVED_VARIABLE_KEY_PREFIXES.some(prefix => stored.startsWith(prefix))
  );
}

/**
 * Server cap: `profile-vars-service.ts`'s `MAX_PROFILE_VARS`. The profile
 * variables screen compares the loaded list's length against it before a new
 * variable goes out, and names the cap in the reader's language.
 */
export const MAX_PROFILE_VARS = 50;

/**
 * Server cap: `contracts/skills.ts`'s `MAX_PROFILE_SKILLS`. The server counts
 * every row of a profile, enabled or not, so the screen compares the loaded
 * list's length against it before a create goes out.
 */
export const MAX_PROFILE_SKILLS = 50;

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

export type SkillInputError = 'empty' | 'too-long' | 'bad-name' | 'no-content';

/**
 * The skill name a pasted SKILL.md offers for the name field: its frontmatter
 * `name`, folded and reduced to the server's pattern. Case and diacritics are
 * folded the way the app's search folds them, each run outside `[a-z0-9]`
 * becomes one dash, and edge dashes are dropped, so `My Skill` fills `my-skill`
 * and `Müller` fills `muller`. A name with no ASCII letter or digit left — a
 * name written in another script — fills nothing, because filling it would only
 * produce a value `validateSkillInput` rejects.
 */
export function skillNameFromMarkdown(markdown: string): string | undefined {
  const { name } = parseSkillFrontmatter(markdown);
  if (name === undefined) {
    return undefined;
  }
  const slug = foldForSearch(name)
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, SKILL_NAME_MAX_LENGTH)
    .replace(/-+$/, '');
  return SKILL_NAME_PATTERN.test(slug) ? slug : undefined;
}

export type SkillInputValidation = { error: SkillInputError | null; description?: string };

/**
 * Validate a pasted custom skill. The name is checked against the server's
 * length bound and pattern, in the order the server's schema applies them, so a
 * name the server would refuse is refused here with the rule that covers it;
 * when the content carries frontmatter, its `description` is returned so the
 * caller can pass it through.
 */
export function validateSkillInput(input: { name: string; content: string }): SkillInputValidation {
  const name = input.name.trim();
  if (name.length === 0) {
    return { error: 'empty' };
  }
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return { error: 'too-long' };
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
 * upper case, with anything outside `A-Z0-9_` replaced by `_`, and a leading
 * `_` when the result would start with a digit, so the stored key satisfies the
 * server's key contract. Matches the web editor's `cleanKey`.
 */
export function cleanVariableKey(value: string): string {
  const cleaned = value.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_');
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** A key is valid when its trimmed length is within the server's 1..128 bound. */
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
