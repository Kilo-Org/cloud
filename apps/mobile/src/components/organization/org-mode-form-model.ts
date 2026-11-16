import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';

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

export type OrgModeFormErrorCode =
  | 'nameRequired'
  | 'identifierRequired'
  | 'identifierInvalid'
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

/** The server's mode-name bound. */
export const ORG_MODE_NAME_MAX_LENGTH = 100;

/** The server's mode-slug bound and character set. */
export const ORG_MODE_SLUG_MAX_LENGTH = 50;

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
 * The slug the create form derives from a name, as the web form derives it:
 * lowercase, every run of other characters folded to one hyphen, no leading or
 * trailing hyphen. A derived slug is a suggestion the person can replace.
 */
export function modeSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

/**
 * What the form refuses before it reaches the server: the required strings, the
 * slug's shape, a slug another mode in this organization already holds, and a
 * file pattern that is not a regular expression. The server repeats the bounds,
 * so this only makes the refusal local.
 */
export function validateOrgModeForm(
  values: OrgModeFormValues,
  existingModes: readonly { id: string; slug: string }[],
  editingModeId?: string
): OrgModeFormErrors {
  const name = values.name.trim();
  const slug = values.slug.trim();
  let slugError: OrgModeFormErrorCode | undefined = undefined;
  if (slug.length === 0) {
    slugError = 'identifierRequired';
  } else if (!SLUG_PATTERN.test(slug) || slug.length > ORG_MODE_SLUG_MAX_LENGTH) {
    slugError = 'identifierInvalid';
  } else if (existingModes.some(mode => mode.slug === slug && mode.id !== editingModeId)) {
    slugError = 'identifierTaken';
  }
  const errors = {
    ...(name.length === 0 ? { name: 'nameRequired' as const } : {}),
    ...(slugError === undefined ? {} : { slug: slugError }),
    ...(values.roleDefinition.trim().length === 0
      ? { roleDefinition: 'roleRequired' as const }
      : {}),
    ...(values.editFileRegex.length > 0 && !isValidRegExp(values.editFileRegex)
      ? { editFileRegex: 'restrictionInvalid' as const }
      : {}),
  } satisfies OrgModeFormErrors;
  return errors;
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
 * The `config` a create or update sends. Empty optional strings are omitted
 * rather than stored as empty text, the tool groups are rebuilt in the server's
 * order so two identical forms send identical payloads, and a file restriction
 * rides on the `edit` group only while that group is enabled.
 */
export function orgModeConfigInput(values: OrgModeFormValues): OrgModeConfigInput {
  const description = values.description.trim();
  const whenToUse = values.whenToUse.trim();
  const customInstructions = values.customInstructions.trim();
  const editFileRegex = values.editFileRegex.trim();
  return {
    roleDefinition: values.roleDefinition.trim(),
    ...(description.length === 0 ? {} : { description }),
    ...(whenToUse.length === 0 ? {} : { whenToUse }),
    ...(customInstructions.length === 0 ? {} : { customInstructions }),
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
