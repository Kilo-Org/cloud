import { ORGANIZATION_NAME_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type TextInputProps, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';
import { useOrganization } from '@/lib/organization-context';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { trpcClient, useTRPC } from '@/lib/trpc';

/**
 * Creates an organization with the same defaults the web create flow uses:
 * `autoAddCreator` (the caller becomes its owner) and the enterprise plan's
 * 14-day trial, which the procedure applies. The name is the only field the
 * app asks for; the company domain is a web dashboard setting, not part of the
 * defaults this screen reproduces.
 *
 * Buying a plan stays on the web: this screen starts the trial, and the
 * organization's billing screen carries the destinations that change it.
 */
export function CreateOrganizationScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { setOrganizationId } = useOrganization();
  // The field keeps what the person typed. Android commits this screen while
  // the create is pending and after it fails, and its text input applies the
  // committed props on every one of those commits, so Android alone mirrors the
  // text into state; iOS keeps an uncontrolled field and reads the ref.
  const nameRef = useRef('');
  const [text, setText] = useState('');
  const [canSubmit, setCanSubmit] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const createOrganization = useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (input: { name: string }) =>
      trpcClient.organizations.create.mutate({ name: input.name, autoAddCreator: true }),
    onSuccess: async ({ organization }) => {
      // The membership has to be in the cached list before the selection moves,
      // or the boundary would read the fresh selection as a lost membership.
      await queryClient.invalidateQueries({ queryKey: trpc.organizations.list.queryKey() });
      setOrganizationId(organization.id);
      router.replace(ORGANIZATION_HUB_PATH);
    },
    onError: (error: unknown) => {
      setErrorText(organizationErrorMessage(error));
    },
  });

  const submit = () => {
    if (createOrganization.isPending) {
      return;
    }
    const name = nameRef.current.trim();
    if (name.length === 0) {
      setErrorText(t('organization.create.nameRequired'));
      return;
    }
    setErrorText(null);
    createOrganization.mutate({ name });
  };

  const pending = createOrganization.isPending;
  const textProps: Pick<TextInputProps, 'value' | 'defaultValue'> =
    Platform.OS === 'android' ? { value: text } : { defaultValue: '' };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.create.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-sm text-muted-foreground">
          {t('organization.create.description')}
        </Text>
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">
            {t('organization.create.nameLabel')}
          </Text>
          <Input
            accessible
            accessibilityLabel={t('organization.create.nameLabel')}
            // Single-line: `leading-[normal]` keeps iOS from drawing the
            // placeholder lower than the typed text, and `min-h-*` (not `py-*`)
            // keeps the text and placeholders centered.
            className="min-h-[44px] rounded-md border border-input bg-background pl-3 pr-3 text-sm leading-[normal] text-foreground"
            placeholder={t('organization.hub.renamePlaceholder')}
            maxLength={ORGANIZATION_NAME_MAX_LENGTH}
            {...textProps}
            autoFocus={Platform.OS !== 'android'}
            editable={!pending}
            onChangeText={value => {
              nameRef.current = value;
              if (Platform.OS === 'android') {
                setText(value);
              }
              setCanSubmit(value.trim().length > 0);
              if (errorText != null) {
                setErrorText(null);
              }
            }}
            onSubmitEditing={submit}
            returnKeyType="done"
            accessibilityState={{ disabled: pending }}
          />
        </View>
        <Text className="text-xs text-muted-foreground">{t('organization.create.trialNote')}</Text>
        {errorText == null ? null : <Text className="text-sm text-destructive">{errorText}</Text>}
        <Button
          className={STATE_ACTION_CLASS}
          onPress={submit}
          disabled={!canSubmit}
          loading={pending}
        >
          <Text className="text-primary-foreground">{t('organization.create.title')}</Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
