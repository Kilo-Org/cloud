import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { z } from 'zod';

import {
  type CredentialDraft,
  ProviderKeyCredentialForm,
} from '@/components/account/provider-key-credential-form';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { CREDENTIAL_INPUT_PROPS } from '@/lib/byok/credential-input-props';
import {
  type BedrockAuthMode,
  type CredentialFieldId,
  credentialForm,
  credentialPayload,
  credentialProblem,
  firstMissingField,
  type ModelMapping,
} from '@/lib/byok/credential-fields';
import {
  providerKeyPermissions,
  providerKeyScope,
  providerKeyScopeInput,
  providerKeysHref,
} from '@/lib/byok/provider-key-scope';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { isRetryableTrpcError, readTrpcErrorField } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

type ProviderOption = inferRouterOutputs<MobileRouter>['byok']['listProviders'][number];

/** The provider, the key it replaces, and the organization whose keys it edits. */
const ParamsSchema = z.object({
  provider: z.string().min(1),
  id: z.uuid().optional(),
  org: z.uuid().optional(),
});

type SaveFailure =
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

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
  const parsedParam = ParamsSchema.safeParse(params);
  const keyRef = useRef('');
  const valuesRef = useRef<CredentialDraft>({});
  const mappingsRef = useRef(new Map<number, Partial<ModelMapping>>());
  const [authMode, setAuthMode] = useState<BedrockAuthMode>('apiKey');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<CredentialFieldId, string>>>({});
  const save = useSurfaceFeedback<SaveFailure>();
  const scope = providerKeyScope(parsedParam.success ? parsedParam.data.org : undefined);
  const scopeInput = providerKeyScopeInput(scope);
  const keyId = parsedParam.success ? parsedParam.data.id : undefined;
  const { role, isResolving } = useOrgBoundary(
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

  if (scope.kind === 'organization' && !isResolving && !permissions.canEdit) {
    // Every write to an organization's keys takes a billing role, so a member
    // who reads them cannot open this form at all.
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={title} />
        <QueryError variant="permission" />
      </View>
    );
  }

  if (providers.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={title} />
        <View className="gap-6 px-4 pt-4">
          <Skeleton className="h-[74px] rounded-lg" />
          <Skeleton className="h-11 rounded-lg" />
        </View>
      </View>
    );
  }

  if (providers.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={title} />
        <QueryError onRetry={() => void providers.refetch()} isRetrying={providers.isFetching} />
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

  /** The credential the server stores: the JSON its fields add up to. */
  const readCredential = ():
    | { readonly tag: 'ready'; readonly apiKey: string }
    | { readonly tag: 'missing'; readonly field: CredentialFieldId }
    | { readonly tag: 'refused' } => {
    if (!form) {
      const apiKey = keyRef.current.trim();
      return apiKey === '' ? { tag: 'missing', field: 'apiKey' } : { tag: 'ready', apiKey };
    }
    const missing = firstMissingField(form, valuesRef.current);
    if (missing) {
      return { tag: 'missing', field: missing };
    }
    // A mapping row the reader added and left empty asks for nothing.
    const modelMappings = [...mappingsRef.current.values()]
      .map(row => ({
        gatewayModelSlug: (row.gatewayModelSlug ?? '').trim(),
        customModelId: (row.customModelId ?? '').trim(),
      }))
      .filter(row => row.gatewayModelSlug !== '' || row.customModelId !== '');
    const problem = credentialProblem({
      providerId: provider.id,
      mode: authMode,
      values: valuesRef.current,
      modelMappings,
    });
    if (problem) {
      return { tag: 'refused' };
    }
    return {
      tag: 'ready',
      apiKey: JSON.stringify(
        credentialPayload({
          providerId: provider.id,
          mode: authMode,
          values: valuesRef.current,
          modelMappings,
        })
      ),
    };
  };

  const submit = async () => {
    const attempt = save.begin();
    if (!attempt) {
      return;
    }
    setFieldErrors({});
    const credential = readCredential();
    if (credential.tag === 'missing' && form) {
      setFieldErrors({
        [credential.field]: t('profile.providerKeys.fieldRequired', {
          field: fieldLabel(credential.field),
        }),
      });
      attempt.fail({ kind: 'refused', message: t('profile.providerKeys.invalidCredentials') });
      return;
    }
    if (credential.tag !== 'ready') {
      attempt.fail({ kind: 'refused', message: t('profile.providerKeys.apiKeyRequired') });
      return;
    }
    try {
      await (keyId === undefined
        ? create.mutateAsync({
            ...scopeInput,
            provider_id: provider.id,
            api_key: credential.apiKey,
          })
        : update.mutateAsync({ ...scopeInput, id: keyId, api_key: credential.apiKey }));
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

  const failure = save.failure;
  let saveFailure: ReactNode = null;
  if (failure) {
    switch (failure.kind) {
      case 'retryable': {
        saveFailure = (
          <View className="gap-2">
            <AccessibleStatus message={failure.message} className="text-sm" />
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => void submit()}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        );
        break;
      }
      case 'refused': {
        saveFailure = <AccessibleStatus message={failure.message} className="text-sm" />;
        break;
      }
      default: {
        saveFailure = assertSurfaceFailureHandled(failure);
      }
    }
  }

  const pending = save.feedback.status === 'pending';

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1">
          <Text className="text-sm font-medium text-foreground">{provider.name}</Text>
          <Text className="text-xs text-muted-foreground">
            {keyId === undefined
              ? t('profile.providerKeys.newKeyDescription')
              : t('profile.providerKeys.editKeyDescription')}
          </Text>
        </View>
        {form ? (
          <ProviderKeyCredentialForm
            form={form}
            mode={authMode}
            onModeChange={setAuthMode}
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
