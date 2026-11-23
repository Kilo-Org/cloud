import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ProviderKeyCredentialForm } from '@/components/account/provider-key-credential-form';
import { ProviderKeySaveFailure } from '@/components/account/provider-key-save-failure';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { CREDENTIAL_INPUT_PROPS } from '@/lib/byok/credential-input-props';
import {
  type BedrockAuthMode,
  type CredentialDraft,
  type CredentialFieldId,
  credentialForm,
  type CredentialRead,
  fieldLabelKey,
  type ModelMapping,
  readStructuredCredential,
  replacesBedrockKey,
  withoutUnshownValues,
} from '@/lib/byok/credential-fields';
import { type KeySaveFailure, refusedKeyMessage } from '@/lib/byok/key-refusal';
import {
  providerKeyNewParams,
  providerKeyPermissions,
  providerKeyScope,
  providerKeyScopeInput,
  providerKeysHref,
} from '@/lib/byok/provider-key-scope';
import { providerKeyName } from '@/lib/byok/provider-key-name';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';

/**
 * The empty field-error state. One shared object, not a fresh `{}`, so an edit
 * with nothing to clear leaves the state identical and React skips the render.
 */
const NO_FIELD_ERRORS: Partial<Record<CredentialFieldId, string>> = {};

/**
 * The form for one provider's credential, entered from the provider picker or
 * from a key row that replaces its value. The value lives in a ref, is sent
 * once, and is never readable after saving. A structured provider gets the
 * fields of the credential the web BYOK form accepts as JSON.
 */
export function ProviderKeyNewScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams();
  // A repeated `?org=` arrives as an array; every other org route takes its
  // first value rather than failing the parse this screen answers with.
  const parsedParam = providerKeyNewParams.safeParse({
    ...params,
    org: normalizeOrgQueryParam(params.org),
  });
  const keyRef = useRef('');
  const valuesRef = useRef<CredentialDraft>({});
  const mappingsRef = useRef(new Map<number, Partial<ModelMapping>>());
  // The method the reader chose, or null while the stored one decides it. An
  // edit opens on the method its saved key used, so replacing a Bedrock key
  // does not start on the other one and drop the fields the reader expects.
  const [chosenMode, setChosenMode] = useState<BedrockAuthMode | null>(null);
  const [fieldErrors, setFieldErrors] =
    useState<Partial<Record<CredentialFieldId, string>>>(NO_FIELD_ERRORS);
  const save = useSurfaceFeedback<KeySaveFailure>();
  const scope = providerKeyScope(parsedParam.success ? parsedParam.data.org : undefined);
  const scopeInput = providerKeyScopeInput(scope);
  const keyId = parsedParam.success ? parsedParam.data.id : undefined;
  const providerId = parsedParam.success ? parsedParam.data.provider : undefined;
  const { role, org, isResolving } = useOrgBoundary(
    scope.kind === 'organization' ? scope.organizationId : undefined
  );
  const permissions = providerKeyPermissions(scope, role);
  const providers = useQuery(trpc.byok.listProviders.queryOptions(scopeInput));
  // Replacing a Bedrock key opens on the method its saved credential used.
  const asksStoredMethod = replacesBedrockKey(providerId, keyId);
  const methodInput = trpc.byok.credentialMethod.queryOptions({ ...scopeInput, id: keyId ?? '' });
  const credentialMethod = useQuery({ ...methodInput, enabled: asksStoredMethod });
  const authMode: BedrockAuthMode = chosenMode ?? credentialMethod.data?.method ?? 'apiKey';
  // The credential is plaintext until it is stored: drop every copy on unmount.
  useEffect(
    () => () => {
      keyRef.current = '';
      valuesRef.current = {};
      mappingsRef.current.clear();
    },
    []
  );

  const create = useMutation(trpc.byok.create.mutationOptions({}));
  const update = useMutation(trpc.byok.update.mutationOptions({}));

  const backHref = providerKeysHref(scope);
  const title = keyId
    ? t('profile.providerKeys.editKeyTitle')
    : t('profile.providerKeys.newKeyTitle');

  if (scope.kind === 'organization' && (isResolving || org == null)) {
    // Not resolved, a failed organization list, or an id the viewer is not a
    // member of: the boundary owns all three, and its failed list is retryable
    // rather than a membership refusal this screen cannot distinguish.
    return <OrganizationBoundary title={title} organizationIdOverride={scope.organizationId} />;
  }

  if (scope.kind === 'organization' && !permissions.canEdit) {
    // Every write to an organization's keys takes a billing role, so a member
    // who reads them cannot open this form at all.
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={title} backFallback={PROFILE_TAB_HREF} />
        <QueryError variant="permission" />
      </View>
    );
  }

  // A stored method still being read may be the other one, so the body waits
  // rather than show fields the reader may have to abandon.
  const waiting = asksStoredMethod && (credentialMethod.isPending || credentialMethod.isError);
  if (providers.isPending || providers.isError || waiting) {
    const stalled = providers.isError ? providers : credentialMethod;
    return (
      <View className="flex-1 bg-background">
        {/* The loaded header names the provider on its subtitle line, so the
            pending header holds that line and the form does not move when the
            provider list answers. */}
        <ScreenHeader
          title={title}
          reserveSubtitle={providers.isPending}
          backFallback={PROFILE_TAB_HREF}
        />
        {stalled.isError ? (
          <QueryError onRetry={() => void stalled.refetch()} isRetrying={stalled.isFetching} />
        ) : (
          <View className={SCREEN_BODY_CLASS}>
            <View className="gap-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-12 rounded-md" />
            </View>
            <Skeleton className="h-11 rounded-md" />
          </View>
        )}
      </View>
    );
  }

  const provider = providers.data.find(row => row.id === providerId);
  if (!provider) {
    return <InvalidRouteState backTo={backHref} />;
  }

  const form = credentialForm(provider.id, authMode);

  /**
   * The credential changed: a refusal shown beside the old value is about a
   * value the reader has already replaced. A clear with nothing to clear must
   * leave state identical, so the form does not render per keystroke.
   */
  const clearFailureOnEdit = () => {
    save.clearWhere(() => true);
    setFieldErrors(previous => (previous === NO_FIELD_ERRORS ? previous : NO_FIELD_ERRORS));
  };

  /** Switching methods drops the values the next one does not show. */
  const changeAuthMode = (mode: BedrockAuthMode) => {
    valuesRef.current = withoutUnshownValues(credentialForm(provider.id, mode), valuesRef.current);
    clearFailureOnEdit();
    setChosenMode(mode);
  };

  /** The credential the server stores: the JSON its fields add up to. */
  const readCredential = (): CredentialRead => {
    if (!form) {
      const apiKey = keyRef.current.trim();
      return apiKey === ''
        ? { tag: 'missing', fields: ['apiKey'] }
        : { tag: 'ready', credential: apiKey };
    }
    return readStructuredCredential({
      providerId: provider.id,
      mode: authMode,
      form,
      values: valuesRef.current,
      rows: [...mappingsRef.current.values()],
    });
  };

  const submit = async () => {
    const attempt = save.begin();
    if (!attempt) {
      return;
    }
    setFieldErrors(NO_FIELD_ERRORS);
    const credential = readCredential();
    if (credential.tag === 'missing') {
      if (form) {
        // Every empty field gets its own message under its own input: the
        // summary says the key is incomplete, but a reader who left the region
        // empty needs to see which field that is.
        const missingErrors: Partial<Record<CredentialFieldId, string>> = {};
        for (const id of credential.fields) {
          missingErrors[id] = t('profile.providerKeys.fieldRequired', {
            field: t(fieldLabelKey(form, id)),
          });
        }
        setFieldErrors(missingErrors);
      }
      attempt.fail({
        kind: 'refused',
        // A structured form names the empty field above, so its summary stays
        // generic about the missing value; a one-value key has no field to
        // point at, so it names the key itself.
        message: form
          ? t('profile.providerKeys.keyIncomplete')
          : t('profile.providerKeys.apiKeyRequired'),
      });
      return;
    }
    if (credential.tag === 'incomplete-mapping' || credential.tag === 'refused') {
      // A half-filled mapping is on screen, so its number points at the row to
      // fix. A refused private key is masked, so the sentence naming what it
      // wants sits under that field; every other refusal names no value the
      // reader can see. The sentence follows the cause: a complete block a
      // passphrase protects is already whole, so only the encrypted case names
      // the passphrase.
      if (credential.tag === 'refused' && credential.field === 'privateKey') {
        setFieldErrors({
          privateKey:
            credential.cause === 'key-encrypted'
              ? t('profile.providerKeys.privateKeyEncrypted')
              : t('profile.providerKeys.privateKeyBlockRequired'),
        });
      }
      attempt.fail({
        kind: 'refused',
        message:
          credential.tag === 'incomplete-mapping'
            ? t('profile.providerKeys.incompleteMapping', { number: credential.mapping })
            : t('profile.providerKeys.invalidCredentials'),
      });
      return;
    }
    try {
      await (keyId === undefined
        ? create.mutateAsync({
            ...scopeInput,
            provider_id: provider.id,
            api_key: credential.credential,
          })
        : update.mutateAsync({ ...scopeInput, id: keyId, api_key: credential.credential }));
    } catch (error) {
      // The server's message can quote the provider's response, which names
      // things this form does not show and does not translate, so the code
      // decides the copy. A failure the server has not settled keeps its own
      // retryable sentence and offers the reader a retry.
      const refusal = refusedKeyMessage(error);
      attempt.fail(
        refusal === null
          ? { kind: 'retryable', message: t('profile.providerKeys.saveFailed') }
          : { kind: 'refused', message: refusal }
      );
      return;
    }
    if (!attempt.owns()) {
      return;
    }
    keyRef.current = '';
    valuesRef.current = {};
    mappingsRef.current.clear();
    // The list the reader returns to is stale the moment this lands.
    void queryClient.invalidateQueries({ queryKey: trpc.byok.list.queryKey(scopeInput) });
    announcingToast.success(
      keyId === undefined ? t('profile.providerKeys.added') : t('profile.providerKeys.updated')
    );
    attempt.abandon();
    router.dismissTo(backHref);
  };

  const pending = save.feedback.status === 'pending';

  return (
    <View className="flex-1 bg-background">
      {/* The provider is the scope of the key, so it is the header's subtitle,
          not a body line that read as a field label with no field. */}
      <ScreenHeader
        title={title}
        subtitle={providerKeyName(provider.id, provider.name)}
        backFallback={PROFILE_TAB_HREF}
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1">
          <Text variant="muted">
            {keyId === undefined
              ? t('profile.providerKeys.newKeyDescription')
              : t('profile.providerKeys.editKeyDescription')}
          </Text>
          {keyId === undefined || !form?.showsModelMappings ? null : (
            <Text variant="caption">{t('profile.providerKeys.editKeyMappingsWarning')}</Text>
          )}
        </View>
        {form ? (
          <ProviderKeyCredentialForm
            form={form}
            mode={authMode}
            onModeChange={changeAuthMode}
            onEdit={clearFailureOnEdit}
            disabled={pending}
            values={valuesRef}
            mappings={mappingsRef}
            errors={fieldErrors}
          />
        ) : (
          <FormField
            label={t('profile.providerKeys.apiKeyLabel')}
            placeholder={t('profile.providerKeys.apiKeyPlaceholder')}
            required
            {...CREDENTIAL_INPUT_PROPS}
            secureTextEntry
            disabled={pending}
            error={fieldErrors.apiKey}
            onChangeText={value => {
              keyRef.current = value;
              clearFailureOnEdit();
            }}
          />
        )}
        <ProviderKeySaveFailure
          failure={save.failure}
          onRetry={() => void submit()}
          retryLabel={t('common.retry')}
        />
        <Button
          className={STATE_ACTION_CLASS}
          loading={pending}
          disabled={pending}
          onPress={() => void submit()}
        >
          <Text>{keyId === undefined ? t('profile.providerKeys.add') : t('common.save')}</Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
