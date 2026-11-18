import { ORGANIZATION_NAME_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { hasVisibleText } from '@kilocode/app-shared/text';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type TextInputProps, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type OrgListEntry } from '@/lib/hooks/use-organization-queries';
import { useRouteFocused } from '@/lib/navigation/route-focus';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { ORGANIZATION_HUB_PATH, ORGANIZATION_HUB_ROUTE_NAME } from '@/lib/organization-navigation';
import { useOrganization } from '@/lib/organization-context';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { trpcClient, useTRPC } from '@/lib/trpc';

import { staleOrganizationScopeExit } from './organization-scope-model';

/**
 * One line under the field: a failure the person can act on, or a result. The
 * attempt counter keys the status line so a retry that fails with the same
 * words as the failure before it still re-announces — a repeated message is
 * a new event for a screen-reader user, not a re-render of the old one.
 */
type CreateMessage = { text: string; tone: 'error' | 'notice'; attempt: number };

/** The navigation object a screen of a Stack sees. */
type StackNavigation = {
  getState: () => { index: number; routes: { name: string }[] };
};

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
  const router = useRouter();
  const navigation = useNavigation<StackNavigation>();
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
  const aliveRef = useRef(true);
  // The create outlives this screen: a back press or a push while the request
  // or the list refresh runs must not move the active organization. The
  // completion reads these live values, never the render that started it.
  // Counts the failed submits this mount has reported as an announced status,
  // so the status line's announcement key (its `key` prop) changes with every
  // new failure even when the words are identical.
  const attemptRef = useRef(0);
  const report = useCallback((text: string, tone: CreateMessage['tone']) => {
    setMessage({ text, tone, attempt: attemptRef.current++ });
  }, []);
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
          report(t('organization.create.createdNotListed'), 'notice');
          return;
        }
        selectOrganizationRef.current(organizationId);
        // The boundary enters this screen with the hub already beneath it, so
        // pushing or replacing with the hub would leave two of them and Back
        // would return to the stale one instead of leaving the flow. Pop over
        // the existing hub instead (`dismissTo` dispatches POP_TO, one commit).
        // POP_TO with no matching route rewrites the stack in one commit, the
        // remove-and-insert shape that crashes the Android native stack, so the
        // push-based entry keeps the push plus post-transition retire.
        const state = navigation.getState();
        const exit = staleOrganizationScopeExit({
          routes: state.routes,
          currentIndex: state.index,
          hubRouteName: ORGANIZATION_HUB_ROUTE_NAME,
        });
        if (exit === 'hub') {
          router.dismissTo(ORGANIZATION_HUB_PATH);
          return;
        }
        stackSafeRouter.replace(ORGANIZATION_HUB_PATH);
      } finally {
        submitLockedRef.current = false;
        setSettling(false);
      }
    },
    [navigation, queryClient, router, stackSafeRouter, t, trpc]
  );

  const createOrganization = useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (input: { name: string }) =>
      trpcClient.organizations.create.mutate({ name: input.name, autoAddCreator: true }),
    ...trpc.organizations.create.mutationOptions({
      // Reachability is the create's outcome, not a precondition: the default
      // `networkMode: 'online'` pauses the mutation while the connectivity
      // manager reports the device offline, so the request is never sent and
      // `isPending` never settles — the button keeps its spinner and the field
      // stays disabled for as long as the outage lasts, with no failure
      // surface. Attempting the request instead lets it fail through the normal
      // path: `onError` releases the form and reports the failure, so the
      // person can retry once the connection is back.
      networkMode: 'always',
      // The refresh that has to land before the selection moves runs after this
      // callback returns. Awaiting it here would keep the button busy, and the
      // field disabled, for as long as that refresh takes.
      onSuccess: ({ organization }: { organization: { id: string } }) => {
        void completeCreate(organization.id);
      },
      onError: (error: unknown) => {
        submitLockedRef.current = false;
        setSettling(false);
        report(organizationErrorMessage(error), 'error');
      },
    }),
  });

  const submit = () => {
    if (createOrganization.isPending || submitLockedRef.current) {
      return;
    }
    const name = nameRef.current.trim();
    if (!hasVisibleText(name)) {
      report(t('organization.create.nameRequired'), 'error');
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
      <ScreenHeader title={t('organization.create.title')} backFallback={PROFILE_TAB_HREF} />
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
          // Keyed on the attempt counter: TalkBack/VoiceOver announce a
          // repeated identical failure as a new event, the way the
          // message-details sheet does for cancel feedback.
          <AccessibleStatus
            key={message.attempt}
            message={message.text}
            tone={message.tone === 'error' ? 'error' : 'status'}
            className="text-sm"
          />
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
