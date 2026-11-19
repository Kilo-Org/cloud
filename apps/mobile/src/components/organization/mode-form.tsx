import { MODE_SLUG_MAX_LENGTH, modeSlugFromName } from '@kilocode/app-shared/organizations';
import { type Href, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  isOrgModeFormDirty,
  MODE_TOOL_GROUPS,
  type ModeToolGroup,
  ORG_MODE_NAME_MAX_LENGTH,
  type OrgMode,
  orgModeConfigInput,
  type OrgModeFormErrorCode,
  type OrgModeFormErrors,
  orgModeFormSaveValues,
  type OrgModeFormValues,
  orgModeFormValues,
  validateOrgModeForm,
} from '@/components/organization/org-mode-form-model';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { ModeOptionalFields } from '@/components/organization/mode-optional-fields';
import { OrgFormActions } from '@/components/organization/org-form-actions';
import { ModeToolsFields } from '@/components/organization/mode-tools-fields';
import { Text } from '@/components/ui/text';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { useOrgModeMutations } from '@/lib/hooks/use-org-modes-queries';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';

const MODES_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/modes' as const;

/** The form's fields in visual order, so a refused Save scrolls to the first one. */
const FIELD_ORDER = ['name', 'slug', 'roleDefinition', 'editFileRegex'] as const;

const ERROR_COPY_KEYS = {
  nameRequired: 'organization.modes.nameRequired',
  identifierRequired: 'organization.modes.identifierRequired',
  identifierInvalid: 'organization.modes.identifierInvalid',
  identifierTaken: 'organization.modes.identifierTaken',
  roleRequired: 'organization.modes.roleRequired',
  restrictionInvalid: 'organization.modes.restrictionInvalid',
} as const satisfies Record<OrgModeFormErrorCode, string>;

type MutableModeValues = {
  -readonly [K in keyof OrgModeFormValues]: OrgModeFormValues[K];
};

const EMPTY_VALUES: OrgModeFormValues = {
  name: '',
  slug: '',
  roleDefinition: '',
  description: '',
  whenToUse: '',
  customInstructions: '',
  groups: [],
  editFileRegex: '',
  editRestrictionLabel: '',
};

export type ModeFormProps = Readonly<{
  organizationId: string;
  /** The mode being edited, or undefined to create one. */
  mode: OrgMode | undefined;
  /** Every mode in the organization, so the form can refuse a taken identifier. */
  existingModes: readonly OrgMode[];
}>;

/**
 * The mode's fields, created or edited.
 *
 * The fields are the ones the web form carries that the router accepts: the name,
 * the identifier, the role definition the mode hands the model, its description,
 * when a person should reach for it, its own instructions, and the tool groups it
 * may use. A file restriction belongs to the `edit` group, so the form offers it
 * only while that group is on.
 *
 * The screen resolves the mode first and mounts this form on a record that already
 * exists, so the fields seed once; every field is then uncontrolled and read
 * through a ref on save (the iOS rule). One dirty flag drives the shared
 * keep-editing gate, so a Back press cannot drop typed text silently.
 */
export function ModeForm({ organizationId, mode, existingModes }: ModeFormProps) {
  const router = useRouter();
  const popOnce = usePopOnce();
  const stackSafeReplace = useStackSafeReplace();
  const { t } = useTranslation();
  const mutations = useOrgModeMutations(organizationId);
  const initial = mode === undefined ? null : orgModeFormValues(mode);
  const values = useRef<MutableModeValues>({ ...(initial ?? EMPTY_VALUES) }).current;
  const [groups, setGroups] = useState<readonly ModeToolGroup[]>(initial?.groups ?? []);
  const [errors, setErrors] = useState<OrgModeFormErrors>({});
  // The uncontrolled fields keep their text in `values`, which React never sees;
  // the hint holds its own snapshot of the two texts it derives from, so a
  // keystroke re-renders it.
  const [hintInputs, setHintInputs] = useState({ name: '', slug: '' });
  const [dirty, setDirty] = useState(false);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<
    'name' | 'slug' | 'roleDefinition' | 'editFileRegex'
  >();
  const guard = useMetadataLeaveGuard({ enabled: true });
  const { confirm, dialog } = useConfirmDialog();

  const currentValues = (nextGroups: readonly ModeToolGroup[] = groups): OrgModeFormValues => ({
    ...values,
    groups: nextGroups,
  });

  // One list for the suggestion and the save, so the hint cannot offer an
  // identifier the save would then derive differently: the suggestion below and
  // `save` both read `takenSlugs`, re-derived from the current `existingModes`.
  const takenSlugs = existingModes.map(m => m.slug);
  // Derived every render, not stored: a create route may mount while the modes
  // query is still pending (an empty list) and a later refetch replaces the
  // list, and the hint must follow the list the save will actually read.
  const suggestion =
    mode === undefined && hintInputs.slug.length === 0
      ? modeSlugFromName(hintInputs.name, takenSlugs)
      : '';

  const syncDirty = (nextGroups: readonly ModeToolGroup[] = groups) => {
    const next = isOrgModeFormDirty(currentValues(nextGroups), initial);
    if (next !== dirty) {
      setDirty(next);
      guard.handleDirtyChange(next);
    }
  };

  const errorFor = (field: keyof OrgModeFormErrors): string | undefined => {
    const code = errors[field];
    return code === undefined ? undefined : t(ERROR_COPY_KEYS[code]);
  };

  const leaveToList = () => {
    guard.leaveWithoutAsking(() => {
      if (router.canGoBack()) {
        popOnce();
        return;
      }
      stackSafeReplace.replace(MODES_LIST_PATH as Href);
    });
  };

  const save = () => {
    // Slug strings, not the router output records: `orgModeFormSaveValues`
    // takes just the slugs, so the form narrows before the call.
    const next = orgModeFormSaveValues(
      currentValues(),
      mode === undefined ? 'create' : 'update',
      takenSlugs
    );
    const found = validateOrgModeForm(next, existingModes, mode?.id);
    setErrors(found);
    const firstInvalid = FIELD_ORDER.find(field => found[field] !== undefined);
    if (firstInvalid !== undefined) {
      scrollToField(firstInvalid);
      return;
    }
    const config = orgModeConfigInput(next, mode === undefined ? 'create' : 'update');
    const name = next.name.trim();
    const slug = next.slug.trim();
    if (mode === undefined) {
      mutations.create.mutate({ name, slug, config }, { onSuccess: leaveToList });
      return;
    }
    mutations.update.mutate({ modeId: mode.id, name, slug, config }, { onSuccess: leaveToList });
  };

  const remove = () => {
    if (mode === undefined) {
      return;
    }
    confirm({
      title: t('organization.modes.deleteTitle'),
      message: t('organization.modes.deleteMessage'),
      confirmLabel: t('organization.modes.deleteAction'),
      onConfirm: () => {
        mutations.remove.mutate({ modeId: mode.id }, { onSuccess: leaveToList });
      },
    });
  };

  const saving = mutations.create.isPending || mutations.update.isPending;
  const removing = mutations.remove.isPending;
  const busy = saving || removing;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={mode === undefined ? t('organization.modes.create') : mode.name} />
      <TabScreenScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1.5" onLayout={fieldLayout('name')}>
          <FormField
            label={t('organization.modes.nameLabel')}
            required
            defaultValue={values.name}
            maxLength={ORG_MODE_NAME_MAX_LENGTH}
            disabled={busy}
            error={errorFor('name')}
            onChangeText={value => {
              values.name = value;
              syncDirty();
              if (errors.name !== undefined) {
                setErrors(previous => ({ ...previous, name: undefined }));
              }
              if (mode === undefined) {
                setHintInputs(previous => ({ ...previous, name: value }));
              }
            }}
          />
        </View>
        <View className="gap-1.5" onLayout={fieldLayout('slug')}>
          <FormField
            label={t('organization.modes.identifierLabel')}
            required
            defaultValue={values.slug}
            maxLength={MODE_SLUG_MAX_LENGTH}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={busy}
            error={errorFor('slug')}
            onChangeText={value => {
              values.slug = value;
              syncDirty();
              if (errors.slug !== undefined) {
                setErrors(previous => ({ ...previous, slug: undefined }));
              }
              if (mode === undefined) {
                setHintInputs(previous => ({ ...previous, slug: value }));
              }
            }}
          />
          <Text variant="caption">
            {suggestion.length === 0
              ? t('organization.modes.identifierHint')
              : `${suggestion} · ${t('organization.modes.identifierHint')}`}
          </Text>
        </View>
        <FormField
          label={t('organization.modes.roleLabel')}
          required
          defaultValue={values.roleDefinition}
          multiline
          textAlignVertical="top"
          className="min-h-28 leading-[1.25rem]"
          containerOnLayout={fieldLayout('roleDefinition')}
          disabled={busy}
          error={errorFor('roleDefinition')}
          onChangeText={value => {
            values.roleDefinition = value;
            syncDirty();
            if (errors.roleDefinition !== undefined) {
              setErrors(previous => ({ ...previous, roleDefinition: undefined }));
            }
          }}
        />
        <ModeOptionalFields
          description={values.description}
          whenToUse={values.whenToUse}
          customInstructions={values.customInstructions}
          disabled={busy}
          onChange={(field, value) => {
            values[field] = value;
            syncDirty();
          }}
        />

        <ModeToolsFields
          groups={groups}
          editFileRegex={values.editFileRegex}
          editRestrictionLabel={values.editRestrictionLabel}
          filePatternError={errorFor('editFileRegex')}
          filePatternLayout={fieldLayout('editFileRegex')}
          disabled={busy}
          onToggleGroup={(group, checked) => {
            const next = checked
              ? MODE_TOOL_GROUPS.filter(
                  candidate => candidate === group || groups.includes(candidate)
                )
              : groups.filter(candidate => candidate !== group);
            setGroups(next);
            syncDirty(next);
          }}
          onChangeFilePattern={value => {
            values.editFileRegex = value;
            syncDirty();
            if (errors.editFileRegex !== undefined) {
              setErrors(previous => ({ ...previous, editFileRegex: undefined }));
            }
          }}
          onChangeRestrictionLabel={value => {
            values.editRestrictionLabel = value;
            syncDirty();
          }}
        />

        <OrgFormActions
          saving={saving}
          removing={removing}
          disabled={busy || !dirty}
          deleteLabel={mode === undefined ? undefined : t('organization.modes.deleteAction')}
          onSave={save}
          onDelete={remove}
        />
      </TabScreenScrollView>
      {dialog}
      {guard.dialog}
    </View>
  );
}
