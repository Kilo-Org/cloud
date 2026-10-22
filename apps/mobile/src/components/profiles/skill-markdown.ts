/**
 * Pure helpers for the profile Skills screen.
 *
 * No React and no React Native imports. The frontmatter parser and the input
 * validation both live in the s2 form module (`@/lib/agent-profile-forms`);
 * this module owns the mapping from a validation error to the `profiles.skill*`
 * copy key plus the row subtitle's copy key.
 */

import { type SkillInputError } from '@/lib/agent-profile-forms';

/** The `profiles.*` copy key for each `validateSkillInput` error code. */
const SKILL_ERROR_KEYS = {
  empty: 'profiles.skillNameRequired',
  'bad-name': 'profiles.skillNameInvalid',
  'no-content': 'profiles.skillContentRequired',
} satisfies Record<SkillInputError, string>;

/**
 * The copy key the sheet shows for a refused skill input. The key names the
 * field at fault, so the sheet can render it under the right field.
 */
export function skillErrorKey(error: SkillInputError): string {
  return SKILL_ERROR_KEYS[error];
}

/** The skill fields the row subtitle reads. Structural, so tests need no tRPC type. */
export type SkillRowSource = { sourceType: string };

/**
 * The muted second line of a skill row: the `profiles.*` copy key for the
 * server's `sourceType`, or `null` when the server sent a value this app has no
 * copy for, so the row can show that raw value instead of an empty line.
 */
export function skillRowSubtitle(skill: SkillRowSource): string | null {
  switch (skill.sourceType) {
    case 'custom': {
      return 'profiles.skillSourceCustom';
    }
    case 'marketplace': {
      return 'profiles.skillSourceMarketplace';
    }
    default: {
      return null;
    }
  }
}
