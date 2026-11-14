import { ORGANIZATION_NAME_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { hasVisibleText } from '@kilocode/app-shared/text';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type TextInputProps, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { useRouteFocused } from '@/lib/navigation/route-focus';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';
import { useOrganization } from '@/lib/organization-context';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { trpcClient, useTRPC } from '@/lib/trpc';

/** One line under the field: a failure the person can act on, or a result. */
type CreateMessage = { text: string; tone: 'error' | 'notice' };

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
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const stackSafeRouter = useStackSafeReplace();
  const routeFocused = useRouteFocused();
  const { setOrganizationId } = useOrganization();
  // The field keeps what the person typed. Android commits this screen while
  // the create is pending and after it fails, and its text input applies the
  // committed props on every one of those commits, so Android alone mirrors the
  // text into state; iOS keeps an uncontrolled field and reads the ref.
  const nameRef = useRef('');
  const [text, setText] = useState('');
  const [canSubmit, setCanSubmit] = useState(false);
  const [message, setMessage] = useState<CreateMessage | null>(null);
  // The submit control stays disabled from the tap until the completion ends,
  // so it never looks actionable while the lock below drops its taps.
  const [settling, setSettling] = useState(false);
  // The create outlives this screen: a back press or a push while the request
  // or the list refresh runs must not move the active organization. The
  // completion reads these live values, never the render that started it.
  const aliveRef = useRef(true);
  const focusedRef = useRef(routeFocused);
  const selectOrganizationRef = useRef(setOrganizationId);
  // A create that already succeeded must not repeat while the list refresh
  // before its selection runs.
  const submitLockedRef = useRef(false);
  useEffect(() => {
    focusedRef.current = routeFocused;
  }, [routeFocused]);
  useEffect(() => {
    selectOrganizationRef.current = setOrganizationId;
  }, [setOrganizationId]);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const completeCreate = useCallback(
    async (organizationId: string) => {
      try {
        // The membership has to be in the cached list before the selection
        // moves, or the boundary would read the fresh selection as a lost
        // membership.
        await queryClient.invalidateQueries({ queryKey: trpc.organizations.list.queryKey() });
        // An abandoned create only refreshes the list: the picker shows the new
        // organization, and the selection it was created from stays put.
        if (!aliveRef.current || !focusedRef.current) {
          return;
        }
        // The refresh resolves after its refetch settles, and a failed refetch
        // leaves the list without the new membership. Moving the selection then
        // would bounce it back with a lost-membership warning, so report the
        // result and keep the form.
        const memberships = queryClient.getQueryData<OrgListEntry[]>(
          trpc.organizations.list.queryKey()
        );
        if (memberships?.some(entry => entry.organizationId === organizationId) !== true) {
          setMessage({ text: t('organization.create.createdNotListed'), tone: 'notice' });
          return;
        }
        selectOrganizationRef.current(organizationId);
        stackSafeRouter.replace(ORGANIZATION_HUB_PATH);
      } finally {
        submitLockedRef.current = false;
        setSettling(false);
      }
    },
    [queryClient, stackSafeRouter, t, trpc]
  );

  const createOrganization = useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (input: { name: string }) =>
      trpcClient.organizations.create.mutate({ name: input.name, autoAddCreator: true }),
    // The refresh that has to land before the selection moves runs after this
    // callback returns. Awaiting it here would keep the button busy, and the
    // field disabled, for as long as that refresh takes.
    onSuccess: ({ organization }) => {
      void completeCreate(organization.id);
    },
    onError: (error: unknown) => {
      submitLockedRef.current = false;
      setSettling(false);
      setMessage({ text: organizationErrorMessage(error), tone: 'error' });
    },
  });

  const submit = () => {
    if (createOrganization.isPending || submitLockedRef.current) {
      return;
    }
    const name = nameRef.current.trim();
    if (!hasVisibleText(name)) {
      setMessage({ text: t('organization.create.nameRequired'), tone: 'error' });
      return;
    }
    setMessage(null);
    submitLockedRef.current = true;
    setSettling(true);
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
              setCanSubmit(hasVisibleText(value));
              if (message != null) {
                setMessage(null);
              }
            }}
            onSubmitEditing={submit}
            returnKeyType="done"
            accessibilityState={{ disabled: pending }}
          />
        </View>
        <Text className="text-xs text-muted-foreground">{t('organization.create.trialNote')}</Text>
        {message == null ? null : (
          <Text
            className={
              message.tone === 'error'
                ? 'text-sm text-destructive'
                : 'text-sm text-muted-foreground'
            }
          >
            {message.text}
          </Text>
        )}
        <Button
          className={STATE_ACTION_CLASS}
          onPress={submit}
          disabled={!canSubmit || settling}
          loading={pending}
        >
          <Text className="text-primary-foreground">{t('organization.create.title')}</Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
