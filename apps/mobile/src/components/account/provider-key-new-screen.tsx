import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';
import { z } from 'zod';

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
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { i18n } from '@/i18n';

type ProviderOption = inferRouterOutputs<MobileRouter>['byok']['listProviders'][number];

const PROVIDER_KEYS_ROUTE = '/(app)/(tabs)/(3_profile)/provider-keys' as Href;

/** The one query parameter this route reads: the provider the picker chose. */
const ProviderParamSchema = z.object({ provider: z.string().min(1) });

/**
 * Why the server refused the key, in the app's own words. Its message can quote
 * the provider's response, which names things this form does not show and does
 * not translate, so only the code decides the copy.
 */
function refusedKeyMessage(error: unknown): string {
  const code = readTrpcErrorField(error, 'code');
  if (code === 'CONFLICT') {
    return i18n.t('profile.providerKeys.keyAlreadyExists');
  }
  if (code === 'PRECONDITION_FAILED') {
    return i18n.t('profile.providerKeys.keyManagedByCodingPlan');
  }
  if (code === 'UNPROCESSABLE_CONTENT') {
    return i18n.t('profile.providerKeys.invalidCredentials');
  }
  return i18n.t('profile.providerKeys.keyStoreFailed');
}

/**
 * The key form for one provider, entered from the provider picker.
 *
 * The value is written into a ref and sent once; the router never returns it, so
 * it is not readable after saving and the screen keeps no copy. It is typed into
 * a masked field, and neither the field nor the mutation logs it.
 *
 * The provider id arrives as a route parameter, which is untrusted text, so it is
 * resolved against the server's own list before it is used: an id the list does
 * not offer is an invalid link, not a key for a provider this form was never
 * meant to add.
 */
export function ProviderKeyNewScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams();
  const parsedParam = ProviderParamSchema.safeParse(params);
  const keyRef = useRef('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const providers = useQuery(trpc.byok.listProviders.queryOptions({}));
  // The value is a plaintext credential; drop the copy this screen holds as soon
  // as it is stored, and when the screen goes away.
  useEffect(
    () => () => {
      keyRef.current = '';
    },
    []
  );

  // The provider the form is for. The route parameter is untrusted text: an id
  // the server does not offer resolves to nothing.
  const provider: ProviderOption | undefined = parsedParam.success
    ? providers.data?.find(row => row.id === parsedParam.data.provider)
    : undefined;

  const create = useMutation(
    trpc.byok.create.mutationOptions({
      onSuccess: () => {
        keyRef.current = '';
        // The list the reader returns to is stale the moment this lands.
        void queryClient.invalidateQueries({ queryKey: trpc.byok.list.queryKey({}) });
        announcingToast.success(t('profile.providerKeys.added'));
        router.dismissTo(PROVIDER_KEYS_ROUTE);
      },
      // The server applies the same credential rules it applies to every stored
      // key; the form reports which one refused this key.
      onError: error => {
        setSubmitError(refusedKeyMessage(error));
      },
    })
  );

  if (providers.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('profile.providerKeys.newKeyTitle')} />
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
        <ScreenHeader title={t('profile.providerKeys.newKeyTitle')} />
        <QueryError onRetry={() => void providers.refetch()} isRetrying={providers.isFetching} />
      </View>
    );
  }

  if (!provider) {
    return <InvalidRouteState backTo={PROVIDER_KEYS_ROUTE} />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.providerKeys.newKeyTitle')} />
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
            {t('profile.providerKeys.newKeyDescription')}
          </Text>
        </View>
        <FormField
          label={t('profile.providerKeys.apiKeyLabel')}
          placeholder={t('profile.providerKeys.apiKeyPlaceholder')}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="password"
          disabled={create.isPending}
          onChangeText={value => {
            keyRef.current = value;
            setSubmitError(null);
          }}
        />
        <AccessibleStatus message={submitError} className="text-sm" />
        <Button
          className={STATE_ACTION_CLASS}
          loading={create.isPending}
          disabled={create.isPending}
          onPress={() => {
            const apiKey = keyRef.current.trim();
            if (apiKey === '') {
              toast.error(t('profile.providerKeys.apiKeyRequired'));
              return;
            }
            setSubmitError(null);
            create.mutate({ provider_id: provider.id, api_key: apiKey });
          }}
        >
          <Text>{t('profile.providerKeys.add')}</Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
