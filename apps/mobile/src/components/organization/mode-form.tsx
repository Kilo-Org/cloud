import { type Href, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  isOrgModeFormDirty,
  MODE_TOOL_GROUPS,
  modeSlugFromName,
  type ModeToolGroup,
  ORG_MODE_NAME_MAX_LENGTH,
  ORG_MODE_SLUG_MAX_LENGTH,
  type OrgMode,
  orgModeConfigInput,
  type OrgModeFormErrorCode,
  type OrgModeFormErrors,
  type OrgModeFormValues,
  orgModeFormValues,
  validateOrgModeForm,
} from '@/components/organization/org-mode-form-model';
import {
  orgCopy,
  type OrgCustomizationCopyKey,
} from '@/components/organization/org-customization-copy';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { ModeOptionalFields } from '@/components/organization/mode-optional-fields';
import { OrgFormActions } from '@/components/organization/org-form-actions';
import { ModeToolsFields } from '@/components/organization/mode-tools-fields';
import { Text } from '@/components/ui/text';
import { useOrgModeMutations } from '@/lib/hooks/use-org-modes-queries';
import { usePopOnce } from '@/lib/navigation/pop-once';

const MODES_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/modes' as const;

const ERROR_COPY_KEYS = {
  nameRequired: 'modesNameRequired',
  identifierRequired: 'modesIdentifierRequired',
  identifierInvalid: 'modesIdentifierInvalid',
  identifierTaken: 'modesIdentifierTaken',
  roleRequired: 'modesRoleRequired',
  restrictionInvalid: 'modesRestrictionInvalid',
} as const satisfies Record<OrgModeFormErrorCode, OrgCustomizationCopyKey>;

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
  const { t } = useTranslation();
  const mutations = useOrgModeMutations(organizationId);
  const initial = mode === undefined ? null : orgModeFormValues(mode);
  const values = useRef<MutableModeValues>({ ...(initial ?? EMPTY_VALUES) }).current;
  const [groups, setGroups] = useState<readonly ModeToolGroup[]>(initial?.groups ?? []);
  const [errors, setErrors] = useState<OrgModeFormErrors>({});
  const [derivedSlug, setDerivedSlug] = useState(initial?.slug ?? '');
  const [dirty, setDirty] = useState(false);
  const guard = useMetadataLeaveGuard({ enabled: true });
  const { confirm, dialog } = useConfirmDialog();

  const currentValues = (): OrgModeFormValues => ({
    ...values,
    // An empty identifier follows the name, which is how the web form derives
    // one; the field itself stays empty until the person replaces it.
    slug: values.slug.length > 0 ? values.slug : modeSlugFromName(values.name),
    groups,
  });

  const syncDirty = () => {
    const next = isOrgModeFormDirty(currentValues(), initial);
    if (next !== dirty) {
      setDirty(next);
      guard.handleDirtyChange(next);
    }
  };

  const errorFor = (field: keyof OrgModeFormErrors): string | undefined => {
    const code = errors[field];
    return code === undefined ? undefined : orgCopy(t, ERROR_COPY_KEYS[code]);
  };

  const leaveToList = () => {
    guard.markClean();
    if (router.canGoBack()) {
      popOnce();
      return;
    }
    router.replace(MODES_LIST_PATH as Href);
  };

  const save = () => {
    const next = currentValues();
    const found = validateOrgModeForm(next, existingModes, mode?.id);
    setErrors(found);
    const failed = Object.keys(found).length > 0;
    if (failed) {
      return;
    }
    const config = orgModeConfigInput(next);
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
      title: orgCopy(t, 'modesDeleteTitle'),
      message: orgCopy(t, 'modesDeleteMessage'),
      confirmLabel: orgCopy(t, 'modesDeleteAction'),
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
      <ScreenHeader title={mode === undefined ? orgCopy(t, 'modesCreate') : mode.name} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-6 pb-10 pt-4"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1.5">
          <FormField
            label={orgCopy(t, 'modesNameLabel')}
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
              if (values.slug.length === 0) {
                setDerivedSlug(modeSlugFromName(value));
              }
            }}
          />
        </View>
        <View className="gap-1.5">
          <FormField
            label={orgCopy(t, 'modesIdentifierLabel')}
            required
            defaultValue={values.slug}
            maxLength={ORG_MODE_SLUG_MAX_LENGTH}
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
            }}
          />
          <Text variant="muted" className="text-xs">
            {values.slug.length > 0 || derivedSlug.length === 0
              ? orgCopy(t, 'modesIdentifierHint')
              : `${derivedSlug} · ${orgCopy(t, 'modesIdentifierHint')}`}
          </Text>
        </View>
        <FormField
          label={orgCopy(t, 'modesRoleLabel')}
          required
          defaultValue={values.roleDefinition}
          multiline
          textAlignVertical="top"
          className="min-h-28 leading-[1.25rem]"
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
          disabled={busy}
          onToggleGroup={(group, checked) => {
            setGroups(previous =>
              checked
                ? MODE_TOOL_GROUPS.filter(
                    candidate => candidate === group || previous.includes(candidate)
                  )
                : previous.filter(candidate => candidate !== group)
            );
            syncDirty();
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
          deleteLabel={mode === undefined ? undefined : orgCopy(t, 'modesDeleteAction')}
          onSave={save}
          onDelete={remove}
        />
      </TabScreenScrollView>
      {dialog}
      {guard.dialog}
    </View>
  );
}
