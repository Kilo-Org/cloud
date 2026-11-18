import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ProviderKeyCredentialForm } from '@/components/account/provider-key-credential-form';
import {
  ProviderKeySaveFailure,
  type SaveFailure,
} from '@/components/account/provider-key-save-failure';
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
  type ModelMapping,
  readStructuredCredential,
  withoutUnshownValues,
} from '@/lib/byok/credential-fields';
import {
  providerKeyNewParams,
  providerKeyPermissions,
  providerKeyScope,
  providerKeyScopeInput,
  providerKeysHref,
} from '@/lib/byok/provider-key-scope';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { isRetryableTrpcError, readTrpcErrorField } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

type ProviderOption = inferRouterOutputs<MobileRouter>['byok']['listProviders'][number];

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
  const [authMode, setAuthMode] = useState<BedrockAuthMode>('apiKey');
  const [fieldErrors, setFieldErrors] =
    useState<Partial<Record<CredentialFieldId, string>>>(NO_FIELD_ERRORS);
  const save = useSurfaceFeedback<SaveFailure>();
  const scope = providerKeyScope(parsedParam.success ? parsedParam.data.org : undefined);
  const scopeInput = providerKeyScopeInput(scope);
  const keyId = parsedParam.success ? parsedParam.data.id : undefined;
  const { role, org, isResolving } = useOrgBoundary(
    scope.kind === 'organization' ? scope.organizationId : undefined
  );
  const permissions = providerKeyPermissions(scope, role);
  const providers = useQuery(trpc.byok.listProviders.queryOptions(scopeInput));
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

  if (providers.isPending || providers.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={title} backFallback={PROFILE_TAB_HREF} />
        {providers.isError ? (
          <QueryError onRetry={() => void providers.refetch()} isRetrying={providers.isFetching} />
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

  const provider: ProviderOption | undefined = parsedParam.success
    ? providers.data.find(row => row.id === parsedParam.data.provider)
    : undefined;
  if (!provider) {
    return <InvalidRouteState backTo={backHref} />;
  }

  const form = credentialForm(provider.id, authMode);
  const fieldLabel = (id: CredentialFieldId) => {
    const field = form?.fields.find(candidate => candidate.id === id);
    return field ? t(field.labelKey) : t('profile.providerKeys.apiKeyLabel');
  };

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
    setAuthMode(mode);
  };

  /** The credential the server stores: the JSON its fields add up to. */
  const readCredential = (): CredentialRead => {
    if (!form) {
      const apiKey = keyRef.current.trim();
      return apiKey === ''
        ? { tag: 'missing', field: 'apiKey' }
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
        setFieldErrors({
          [credential.field]: t('profile.providerKeys.fieldRequired', {
            field: fieldLabel(credential.field),
          }),
        });
      }
      attempt.fail({
        kind: 'refused',
        // A structured form names the empty field above, so its summary is the
        // general refusal; a one-value key has no field to point at.
        message: form
          ? t('profile.providerKeys.invalidCredentials')
          : t('profile.providerKeys.apiKeyRequired'),
      });
      return;
    }
    if (credential.tag === 'incomplete-mapping' || credential.tag === 'refused') {
      // A half-filled mapping is on screen, so its number points at the row to
      // fix; every other shape refusal names no value the reader can see.
      const message =
        credential.tag === 'incomplete-mapping'
          ? t('profile.providerKeys.incompleteMapping', { number: credential.mapping })
          : t('profile.providerKeys.invalidCredentials');
      attempt.fail({ kind: 'refused', message });
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
      attempt.fail({
        kind: isRetryableTrpcError(error) ? 'retryable' : 'refused',
        // The server applies the same credential rules it applies to every
        // stored key, so its message is the specific account of the refusal.
        message: readTrpcErrorField(error, 'message') ?? t('profile.providerKeys.saveFailed'),
      });
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

  const saveFailure = (
    <ProviderKeySaveFailure
      failure={save.failure}
      onRetry={() => void submit()}
      retryLabel={t('common.retry')}
    />
  );

  const pending = save.feedback.status === 'pending';

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} backFallback={PROFILE_TAB_HREF} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1">
          <Text variant="small">{provider.name}</Text>
          <Text variant="caption">
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
        {saveFailure}
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
