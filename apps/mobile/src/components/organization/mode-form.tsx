/* eslint-disable max-lines -- one form: the wrapper that owns the durable draft, the loading shape it gates a create on, and the body that seeds from it */
import { MODE_SLUG_MAX_LENGTH, modeSlugFromName } from '@kilocode/app-shared/organizations';
import { type Href, useRouter } from 'expo-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  isOrgModeFormDirty,
  isOrgModeFormDraft,
  MODE_TOOL_GROUPS,
  type ModeToolGroup,
  ORG_MODE_NAME_MAX_LENGTH,
  type OrgMode,
  orgModeConfigInput,
  type OrgModeFormDraft,
  type OrgModeFormErrorCode,
  type OrgModeFormErrors,
  orgModeFormSaveValues,
  type OrgModeFormTarget,
  type OrgModeFormValues,
  orgModeFormValues,
  validateOrgModeForm,
} from '@/components/organization/org-mode-form-model';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { ModeOptionalFields } from '@/components/organization/mode-optional-fields';
import { OrgFormActions } from '@/components/organization/org-form-actions';
import { ModeToolsFields } from '@/components/organization/mode-tools-fields';
import { Text } from '@/components/ui/text';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { useOrgModeMutations } from '@/lib/hooks/use-org-modes-queries';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { orgModeFormDraftKey } from '@/lib/persist/drafts';
import { type FormDraftState, useFormDraft } from '@/lib/persist/use-form-draft';

const MODES_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/modes' as const;

/** The form's fields in visual order, so a refused Save scrolls to the first one. */
const FIELD_ORDER = ['name', 'slug', 'roleDefinition', 'editFileRegex'] as const;

const ERROR_COPY_KEYS = {
  nameRequired: 'organization.modes.nameRequired',
  identifierRequired: 'organization.modes.identifierRequired',
  identifierInvalid: 'organization.modes.identifierInvalid',
  identifierTooLong: 'organization.modes.identifierTooLong',
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

/** The branch of `useFormDraft` a mounted body reads. */
type FormDraft<T> = Extract<FormDraftState<T>, { kind: 'ready' }>;

export type ModeFormProps = Readonly<{
  organizationId: string;
  /** Whether the reader may change the plan; it picks the refusal's sentence. */
  canManageBilling?: boolean;
  /** The mode being edited, or undefined to create one. */
  mode: OrgMode | undefined;
  /** Every mode in the organization, so the form can refuse a taken identifier. */
  existingModes: readonly OrgMode[];
}>;

/**
 * The mode's fields, created or edited, on top of the form's durable draft.
 *
 * A device language change that flips the text direction reloads the JS bundle
 * (`apply-language.ts`), which kills the React tree without running its cleanup,
 * so the fields' text lives in the encrypted draft store as well as in their
 * refs. This wrapper owns that store: it loads the draft under the current
 * account and the mode's own key, and hands the body the loaded value.
 */
export function ModeForm({
  organizationId,
  canManageBilling = false,
  mode,
  existingModes,
}: ModeFormProps) {
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const draft = useFormDraft<OrgModeFormDraft>({
    userId,
    isIdentityLoading,
    entityKey: orgModeFormDraftKey(organizationId, mode?.id ?? null),
    validate: isOrgModeFormDraft,
  });
  // A create gated on the draft and an edit does not: a create has nothing to
  // show without it — there is no server record — so it holds its loading state
  // until the store answers and its uncontrolled fields seed once, never
  // twice; an edit already has the server row, so it shows that at once and the
  // body applies a restored draft only while the person has not typed.
  if (mode === undefined && draft.kind === 'loading') {
    return <ModeFormSkeleton />;
  }

  return (
    <ModeFormBody
      organizationId={organizationId}
      canManageBilling={canManageBilling}
      mode={mode}
      existingModes={existingModes}
      draft={{
        kind: 'ready',
        value: draft.kind === 'ready' ? draft.value : null,
        save: draft.save,
        clear: draft.clear,
      }}
    />
  );
}

/**
 * The create form's shape while its stored draft loads: the blocks the body
 * paints — the name and identifier rows, the role block, then the tool section.
 */
function ModeFormSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.modes.create')} />
      <View className={SCREEN_BODY_CLASS}>
        <Skeleton className="h-11 rounded-lg" />
        <Skeleton className="h-11 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        {/* The five tool rows of the section below. */}
        <Skeleton className="h-56 rounded-lg" />
      </View>
    </View>
  );
}

type ModeFormBodyProps = Readonly<{
  organizationId: string;
  /** Whether the reader may change the plan; it picks the refusal's sentence. */
  canManageBilling: boolean;
  mode: OrgMode | undefined;
  existingModes: readonly OrgMode[];
  draft: FormDraft<OrgModeFormDraft>;
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
 * The fields seed once — from the restored draft, else the server row, else
 * nothing — and are then uncontrolled and read through a ref on save (the iOS
 * rule). One dirty flag drives the shared keep-editing gate, so a Back press
 * cannot drop typed text silently; every edit also writes the whole form to the
 * durable draft, because a reload runs no cleanup.
 */
function ModeFormBody({
  organizationId,
  canManageBilling,
  mode,
  existingModes,
  draft,
}: ModeFormBodyProps) {
  const router = useRouter();
  const popOnce = usePopOnce();
  const stackSafeReplace = useStackSafeReplace();
  const { t } = useTranslation();
  const mutations = useOrgModeMutations(organizationId, canManageBilling);
  const initial = mode === undefined ? null : orgModeFormValues(mode);
  // The best content this body already has: the restored draft, else the mode it
  // edits, else an empty create form.
  const seed = draft.value ?? initial ?? EMPTY_VALUES;
  const values = useRef<MutableModeValues>({ ...seed }).current;
  const [groups, setGroups] = useState<readonly ModeToolGroup[]>(seed.groups);
  const [errors, setErrors] = useState<OrgModeFormErrors>({});
  // The uncontrolled fields keep their text in `values`, which React never sees;
  // the hint holds its own snapshot of the two texts it derives from, so a
  // keystroke re-renders it. Seeded from the same content, so a restored draft
  // renders its identifier hint immediately.
  const [hintInputs, setHintInputs] = useState({ name: seed.name, slug: seed.slug });
  const [dirty, setDirty] = useState(false);
  // A restored draft that arrived after this body mounted re-seeds the
  // uncontrolled fields by remounting them under this key.
  const [applyGeneration, setApplyGeneration] = useState(0);
  // Set by the first edit of any field: a restored draft never overwrites text
  // the person typed.
  const touchedRef = useRef(false);
  // A draft that already seeded the mount (or the create's gate) is applied.
  const appliedRef = useRef(draft.value !== null);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<
    'name' | 'slug' | 'roleDefinition' | 'editFileRegex'
  >();
  const saving = mutations.create.isPending || mutations.update.isPending;
  const removing = mutations.remove.isPending;
  const busy = saving || removing;
  const guard = useMetadataLeaveGuard({ enabled: true, saving: busy, onDiscard: draft.clear });
  const { confirm, dialog } = useConfirmDialog();

  const currentValues = (nextGroups: readonly ModeToolGroup[] = groups): OrgModeFormValues => ({
    ...values,
    groups: nextGroups,
  });

  // One list for the suggestion and the save, so the placeholder cannot offer
  // an identifier the save would then derive differently: the suggestion below
  // and `save` both read `takenSlugs`, re-derived from the current
  // `existingModes`.
  const takenSlugs = existingModes.map(m => m.slug);
  // Derived every render, not stored: a create route may mount while the modes
  // query is still pending (an empty list) and a later refetch replaces the
  // list, and the placeholder must follow the list the save will actually read.
  // Offered as the identifier field's placeholder rather than as typed text, so
  // an empty field never looks filled.
  const suggestion =
    mode === undefined && hintInputs.slug.length === 0
      ? modeSlugFromName(hintInputs.name, takenSlugs)
      : '';

  const syncDirty = (nextGroups: readonly ModeToolGroup[] = groups) => {
    const next = isOrgModeFormDirty(currentValues(nextGroups), initial);
    setDirty(next);
    // Reported on every edit, not only on a change of this form's own verdict: a
    // caller-driven leave whose pop the navigator dropped leaves the form mounted
    // with `dirty` still true while the guard stands down, so a gated report would
    // never re-arm it and a later Back would leave silently with the draft. The
    // hook's `setState` bails out on an unchanged value, so repeating the verdict
    // costs nothing.
    guard.handleDirtyChange(next);
  };

  /** One edit: the person's text is now theirs, so record the verdict and the draft. */
  const editValues = (nextGroups: readonly ModeToolGroup[] = groups) => {
    touchedRef.current = true;
    syncDirty(nextGroups);
    draft.save(currentValues(nextGroups));
  };

  // The guard arms from the mount, not from the first keystroke: a body that
  // opened on a restored draft (the reload this draft exists for) would
  // otherwise let a Back leave without asking.
  useEffect(() => {
    syncDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one mount verdict over the content the body opened with
  }, []);

  // The restored draft that arrived after an edit body mounted: applied once,
  // and only while the person has not typed into any field.
  useEffect(() => {
    const restored = draft.value;
    if (restored === null || touchedRef.current || appliedRef.current) {
      return;
    }
    appliedRef.current = true;
    Object.assign(values, restored);
    setGroups(restored.groups);
    setHintInputs({ name: restored.name, slug: restored.slug });
    setApplyGeneration(generation => generation + 1);
    syncDirty(restored.groups);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the restored value: `values` is one mutable ref object and the setters are stable
  }, [draft.value]);

  // Every code reads its copy through the same call: only the too-long message
  // carries `{{max}}`, and the others ignore the value.
  const errorFor = (field: keyof OrgModeFormErrors): string | undefined => {
    const code = errors[field];
    return code === undefined ? undefined : t(ERROR_COPY_KEYS[code], { max: MODE_SLUG_MAX_LENGTH });
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

  // The draft became the saved record (or the record is gone), so its stored
  // copy goes before the screen leaves.
  const leaveAfterSave = () => {
    draft.clear();
    leaveToList();
  };

  const save = () => {
    // One target for the whole save: the same fact decides the derivation, the
    // refusal and the mutation, so the three cannot disagree.
    const target: OrgModeFormTarget =
      mode === undefined ? { kind: 'create' } : { kind: 'update', modeId: mode.id };
    // Slug strings, not the router output records: `orgModeFormSaveValues`
    // takes just the slugs, so the form narrows before the call.
    const next = orgModeFormSaveValues(currentValues(), target.kind, takenSlugs);
    const found = validateOrgModeForm(next, existingModes, target);
    setErrors(found);
    const firstInvalid = FIELD_ORDER.find(field => found[field] !== undefined);
    if (firstInvalid !== undefined) {
      scrollToField(firstInvalid);
      return;
    }
    const config = orgModeConfigInput(next, target.kind);
    const name = next.name.trim();
    const slug = next.slug.trim();
    if (target.kind === 'create') {
      mutations.create.mutate({ name, slug, config }, { onSuccess: leaveAfterSave });
      return;
    }
    mutations.update.mutate(
      { modeId: target.modeId, name, slug, config },
      { onSuccess: leaveAfterSave }
    );
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
        mutations.remove.mutate({ modeId: mode.id }, { onSuccess: leaveAfterSave });
      },
    });
  };

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
        {/* Keyed by the applied draft: a remount re-reads every `defaultValue`
            from `values`, which a live uncontrolled input would ignore. */}
        <Fragment key={applyGeneration}>
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
                editValues();
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
              required={mode !== undefined}
              defaultValue={values.slug}
              placeholder={suggestion.length > 0 ? suggestion : undefined}
              maxLength={MODE_SLUG_MAX_LENGTH}
              autoCapitalize="none"
              autoCorrect={false}
              disabled={busy}
              error={errorFor('slug')}
              onChangeText={value => {
                values.slug = value;
                editValues();
                if (errors.slug !== undefined) {
                  setErrors(previous => ({ ...previous, slug: undefined }));
                }
                if (mode === undefined) {
                  setHintInputs(previous => ({ ...previous, slug: value }));
                }
              }}
            />
            <Text variant="caption">{t('organization.modes.identifierHint')}</Text>
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
              editValues();
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
              editValues();
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
              editValues(next);
            }}
            onChangeFilePattern={value => {
              values.editFileRegex = value;
              editValues();
              if (errors.editFileRegex !== undefined) {
                setErrors(previous => ({ ...previous, editFileRegex: undefined }));
              }
            }}
            onChangeRestrictionLabel={value => {
              values.editRestrictionLabel = value;
              editValues();
            }}
          />
        </Fragment>

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
