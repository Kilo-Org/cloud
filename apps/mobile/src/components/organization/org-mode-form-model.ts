import { MODE_SLUG_MAX_LENGTH, modeSlugFromName } from '@kilocode/app-shared/organizations';
import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';
import * as z from 'zod';

type OrgModeOutput =
  inferRouterOutputs<MobileRouter>['organizations']['modes']['list']['modes'][number];

/** A stored organization mode, from the mobile router's own output type. */
export type OrgMode = OrgModeOutput;

/**
 * The config a mode create or update carries. The stored column is the same
 * shape with every field optional, so the form reads through `?? ''`.
 */
export type OrgModeConfigInput = NonNullable<
  inferRouterInputs<MobileRouter>['organizations']['modes']['create']['config']
>;

/** The restriction the `edit` group may carry: which files stay editable. */
type EditGroupRestriction = Readonly<{ fileRegex?: string; description?: string }>;

/**
 * The tool groups an organization mode may enable, in the order the form
 * presents them. The server's config schema accepts exactly these names, so the
 * form offers exactly these.
 */
export const MODE_TOOL_GROUPS = ['read', 'edit', 'browser', 'command', 'mcp'] as const;

export type ModeToolGroup = (typeof MODE_TOOL_GROUPS)[number];

export type OrgModeFormValues = Readonly<{
  name: string;
  slug: string;
  roleDefinition: string;
  description: string;
  whenToUse: string;
  customInstructions: string;
  groups: readonly ModeToolGroup[];
  /** A file-pattern restriction on `edit`; empty leaves every file editable. */
  editFileRegex: string;
  /** The restriction's own label, shown beside the group on the web. */
  editRestrictionLabel: string;
}>;

/**
 * A mode form's durable draft: the whole typed form, so a restored draft seeds
 * every field — not a per-field patch a person would have to reconcile.
 */
export type OrgModeFormDraft = OrgModeFormValues;

/**
 * The draft's stored shape. Strict on purpose: a value that carries any other
 * key was written by a build with a different form, so the caller reads it as no
 * draft and leaves it stored rather than coercing a shape it does not know.
 */
const orgModeFormDraftSchema = z.strictObject({
  name: z.string(),
  slug: z.string(),
  roleDefinition: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  customInstructions: z.string(),
  groups: z.array(z.enum(MODE_TOOL_GROUPS)),
  editFileRegex: z.string(),
  editRestrictionLabel: z.string(),
});

/** Shape guard for a stored mode form draft; another build's value is refused. */
export function isOrgModeFormDraft(value: unknown): value is OrgModeFormDraft {
  return orgModeFormDraftSchema.safeParse(value).success;
}

export type OrgModeFormErrorCode =
  | 'nameRequired'
  | 'identifierRequired'
  | 'identifierInvalid'
  | 'identifierTooLong'
  | 'identifierTaken'
  | 'roleRequired'
  | 'restrictionInvalid';

/**
 * What the form refuses, per field. Written out rather than mapped over the field
 * names: a mapped record reads as an open dictionary to the type audit, and the
 * four fields are a closed set.
 */
export type OrgModeFormErrors = Readonly<{
  name?: OrgModeFormErrorCode;
  slug?: OrgModeFormErrorCode;
  roleDefinition?: OrgModeFormErrorCode;
  editFileRegex?: OrgModeFormErrorCode;
}>;

/**
 * The form a save judges. A create has no stored row and derives an empty
 * identifier from the name, so it can refuse neither an empty identifier nor a
 * clash with itself; an update edits one stored row, which holds the identifier
 * that a cleared field would drop.
 */
export type OrgModeFormTarget =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'update'; modeId: string }>;

/** The server's mode-name bound. */
export const ORG_MODE_NAME_MAX_LENGTH = 100;

/** The server's mode-slug character set; the length bound lives with the derivation. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** Whether a file pattern the person typed compiles as a regular expression. */
function isValidRegExp(source: string): boolean {
  try {
    new RegExp(source).test('');
    return true;
  } catch {
    return false;
  }
}

/**
 * What the form refuses before it reaches the server: the required strings, the
 * slug's shape, a slug longer than the server's bound (reported apart from the
 * character set, so a long suggestion reads as too long rather than as invalid
 * characters), a slug another mode in this organization already holds, and a
 * file pattern that is not a regular expression. The server repeats the bounds,
 * so this only makes the refusal local. The pattern belongs to the `edit` group,
 * so it is checked only while that group is on — the same rule
 * `orgModeConfigInput` follows when it drops the restriction with the group.
 *
 * A create derives an empty identifier from the name on save, so only an update
 * can lose one: the name is the one value a create must supply. An update is
 * judged as the row it edits, so the identifier it already holds is not a clash
 * with itself.
 */
export function validateOrgModeForm(
  values: OrgModeFormValues,
  existingModes: readonly { id: string; slug: string }[],
  target: OrgModeFormTarget
): OrgModeFormErrors {
  const name = values.name.trim();
  const slug = values.slug.trim();
  // The row an update edits, or nothing on create: the identifier a create would
  // derive is checked against every mode, an update's own slug is not.
  const editingModeId = target.kind === 'update' ? target.modeId : undefined;
  let slugError: OrgModeFormErrorCode | undefined = undefined;
  if (slug.length === 0) {
    slugError = target.kind === 'update' ? 'identifierRequired' : undefined;
  } else if (!SLUG_PATTERN.test(slug)) {
    slugError = 'identifierInvalid';
  } else if (slug.length > MODE_SLUG_MAX_LENGTH) {
    slugError = 'identifierTooLong';
  } else if (existingModes.some(mode => mode.slug === slug && mode.id !== editingModeId)) {
    slugError = 'identifierTaken';
  }
  const restrictionInvalid =
    values.groups.includes('edit') &&
    values.editFileRegex.length > 0 &&
    !isValidRegExp(values.editFileRegex);
  const errors = {
    ...(name.length === 0 ? { name: 'nameRequired' as const } : {}),
    ...(slugError === undefined ? {} : { slug: slugError }),
    ...(values.roleDefinition.trim().length === 0
      ? { roleDefinition: 'roleRequired' as const }
      : {}),
    ...(restrictionInvalid ? { editFileRegex: 'restrictionInvalid' as const } : {}),
  } satisfies OrgModeFormErrors;
  return errors;
}

/**
 * The values a save reads. A create whose identifier the person left empty
 * follows the name, as the web form derives one — counting past the slugs the
 * organization's other modes hold; an update derives nothing, so clearing the
 * identifier is reported as missing instead of silently renaming a mode whose
 * slug overrides a built-in or carries an Organization Auto route.
 */
export function orgModeFormSaveValues(
  values: OrgModeFormValues,
  mode: 'create' | 'update',
  takenSlugs: readonly string[]
): OrgModeFormValues {
  if (mode === 'update' || values.slug.trim().length > 0) {
    return values;
  }
  return { ...values, slug: modeSlugFromName(values.name, takenSlugs) };
}

/**
 * Whether the form holds a change. A create form starts empty, so any typed text
 * counts; an edit form compares against the mode it opened with.
 */
export function isOrgModeFormDirty(
  values: OrgModeFormValues,
  initial: OrgModeFormValues | null
): boolean {
  if (initial === null) {
    return (
      values.name.trim().length > 0 ||
      values.slug.trim().length > 0 ||
      values.roleDefinition.trim().length > 0 ||
      values.description.trim().length > 0 ||
      values.whenToUse.trim().length > 0 ||
      values.customInstructions.trim().length > 0 ||
      values.editFileRegex.length > 0 ||
      values.editRestrictionLabel.length > 0
    );
  }
  return (
    values.name !== initial.name ||
    values.slug !== initial.slug ||
    values.roleDefinition !== initial.roleDefinition ||
    values.description !== initial.description ||
    values.whenToUse !== initial.whenToUse ||
    values.customInstructions !== initial.customInstructions ||
    values.editFileRegex !== initial.editFileRegex ||
    values.editRestrictionLabel !== initial.editRestrictionLabel ||
    MODE_TOOL_GROUPS.some(g => values.groups.includes(g) !== initial.groups.includes(g))
  );
}

function editRestrictionOf(groups: NonNullable<OrgModeOutput['config']['groups']>) {
  const entry = groups.find(group => Array.isArray(group));
  if (entry === undefined || !Array.isArray(entry)) {
    return { editFileRegex: '', editRestrictionLabel: '' };
  }
  const restriction = entry[1] as EditGroupRestriction | undefined;
  return {
    editFileRegex: restriction?.fileRegex ?? '',
    editRestrictionLabel: restriction?.description ?? '',
  };
}

/** The mode's stored config as the form's own values. */
export function orgModeFormValues(mode: OrgMode): OrgModeFormValues {
  const groups = mode.config.groups ?? [];
  return {
    name: mode.name,
    slug: mode.slug,
    roleDefinition: mode.config.roleDefinition ?? '',
    description: mode.config.description ?? '',
    whenToUse: mode.config.whenToUse ?? '',
    customInstructions: mode.config.customInstructions ?? '',
    groups: MODE_TOOL_GROUPS.filter(group =>
      groups.some(entry => (Array.isArray(entry) ? entry[0] : entry) === group)
    ),
    ...editRestrictionOf(groups),
  };
}

/**
 * The `config` a create or update sends. A create omits empty optional strings
 * rather than storing empty text. An update sends them as empty strings: the
 * server applies `config` as a JSONB patch over the stored row
 * (`updateOrganizationMode`), so an omitted key keeps its previous value and
 * clearing a field would be a silent no-op. The tool groups are rebuilt in the
 * server's order so two identical forms send identical payloads, and a file
 * restriction rides on the `edit` group only while that group is enabled.
 */
export function orgModeConfigInput(
  values: OrgModeFormValues,
  mode: 'create' | 'update'
): OrgModeConfigInput {
  const description = values.description.trim();
  const whenToUse = values.whenToUse.trim();
  const customInstructions = values.customInstructions.trim();
  const editFileRegex = values.editFileRegex.trim();
  const clearing = mode === 'update';
  return {
    roleDefinition: values.roleDefinition.trim(),
    ...(description.length === 0 && !clearing ? {} : { description }),
    ...(whenToUse.length === 0 && !clearing ? {} : { whenToUse }),
    ...(customInstructions.length === 0 && !clearing ? {} : { customInstructions }),
    groups: MODE_TOOL_GROUPS.filter(group => values.groups.includes(group)).map(group =>
      group === 'edit' && editFileRegex.length > 0
        ? [
            'edit',
            {
              fileRegex: editFileRegex,
              ...(values.editRestrictionLabel.trim().length === 0
                ? {}
                : { description: values.editRestrictionLabel.trim() }),
            },
          ]
        : group
    ),
  };
}
