import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

type ProfileUrlError = (value: string) => string | null;

/**
 * The rule `user.updateProfile` applies, checked before the round trip so a typo
 * is reported beside its field. An empty value is valid: it means "clear this
 * link", which is why an empty string is submitted as `null`.
 */
function createProfileUrlError(message: string): ProfileUrlError {
  return value => {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    try {
      const url = new URL(trimmed);
      return url.protocol === 'http:' || url.protocol === 'https:' ? null : message;
    } catch {
      return message;
    }
  };
}

/** The submitted value of a URL field: absent when untouched, null when cleared. */
function submittedUrl(value: string, initial: string | null): string | null | undefined {
  const trimmed = value.trim();
  if (trimmed === (initial ?? '')) {
    return undefined;
  }
  return trimmed === '' ? null : trimmed;
}

type FieldsProps = {
  readonly linkedinUrl: string | null;
  readonly githubUrl: string | null;
  /** The screen's one exit: the save completing, or a Save that changed nothing. */
  readonly onDone: () => void;
};

/**
 * The form itself, mounted only once the saved links have arrived: the fields are
 * uncontrolled (a ref per field, `defaultValue` for the initial text), so they
 * cannot be filled in by a query that settles after their first render.
 *
 * The fields stay editable while a save is pending, and the Save button carries
 * the whole busy state. Disabling them repaints the Android text input as
 * `opacity-50`, and that attribute change makes Fabric publish a text state built
 * from `defaultValue` — the link last saved — so the field would show the old
 * link for the whole pending window and drop the typed one for good. Keeping the
 * fields live is also the rule the other saving forms follow (the new-session
 * prompt states it): the person can still read the link being sent, and a refused
 * save leaves it there to retry.
 */
function ProfileLinkForm({ linkedinUrl, githubUrl, onDone }: FieldsProps) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const linkedinRef = useRef(linkedinUrl ?? '');
  const githubRef = useRef(githubUrl ?? '');
  // A save that is already in flight must not be sent again by a press that
  // arrives before the pending render commits.
  const submitLockedRef = useRef(false);
  const [linkedinError, setLinkedinError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const invalidUrlMessage = t('profile.editProfile.invalidUrl');
  const validateUrl = createProfileUrlError(invalidUrlMessage);

  const update = useMutation(
    trpc.user.updateProfile.mutationOptions({
      onSuccess: () => {
        // A completion can arrive after the reader left, and this form can still
        // be mounted then; releasing the lock keeps Save usable for a later edit.
        submitLockedRef.current = false;
        // The screen's read is cached for the default staleTime, so a quick return
        // would show the links as they were before this save.
        void queryClient.invalidateQueries({ queryKey: trpc.user.getProfileLinks.queryKey() });
        announcingToast.success(t('profile.editProfile.saved'));
        // Same rule as the header's Back: if the reader already left during the
        // save, this completion is dropped instead of popping the screen beneath.
        onDone();
      },
      // The server's message is the account of what it refused, so it is shown
      // as written rather than replaced with a generic failure. A refused save
      // releases the form so the typed link can be sent again.
      onError: error => {
        submitLockedRef.current = false;
        toast.error(error.message);
      },
    })
  );

  const onSubmit = () => {
    // One save at a time. `update.isPending` is read from the render that made
    // this closure, so a press dispatched before the pending render commits
    // still sees `false` and would reach `mutate` a second time; the ref is
    // shared across renders and is set before the request, so it closes that
    // window. `isPending` stays the settle-time half of the check: it holds
    // until the mutation actually settles, including the wait for it to start.
    if (update.isPending || submitLockedRef.current) {
      return;
    }
    const linkedin = submittedUrl(linkedinRef.current, linkedinUrl);
    const github = submittedUrl(githubRef.current, githubUrl);
    const nextLinkedinError = validateUrl(linkedinRef.current);
    const nextGithubError = validateUrl(githubRef.current);
    setLinkedinError(nextLinkedinError);
    setGithubError(nextGithubError);
    if (nextLinkedinError !== null || nextGithubError !== null) {
      return;
    }
    if (linkedin === undefined && github === undefined) {
      onDone();
      return;
    }
    submitLockedRef.current = true;
    update.mutate({
      ...(linkedin === undefined ? {} : { linkedin_url: linkedin }),
      ...(github === undefined ? {} : { github_url: github }),
    });
  };

  return (
    <>
      <FormField
        label={t('profile.editProfile.linkedinLabel')}
        defaultValue={linkedinUrl ?? ''}
        placeholder="https://www.linkedin.com/in/…"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        validate={validateUrl}
        error={linkedinError ?? undefined}
        // The rule can arrive from a Save press, with no focus on this field,
        // so the slot is held from the first render: the Save button beneath
        // never moves between the untouched form and a shown error.
        alwaysReserve
        reserveErrorMessages={[invalidUrlMessage]}
        onChangeText={value => {
          linkedinRef.current = value;
          setLinkedinError(null);
        }}
      />
      <FormField
        label={t('profile.editProfile.githubLabel')}
        defaultValue={githubUrl ?? ''}
        placeholder="https://github.com/…"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        validate={validateUrl}
        error={githubError ?? undefined}
        alwaysReserve
        reserveErrorMessages={[invalidUrlMessage]}
        onChangeText={value => {
          githubRef.current = value;
          setGithubError(null);
        }}
      />
      <Button
        className={STATE_ACTION_CLASS}
        onPress={onSubmit}
        loading={update.isPending}
        disabled={update.isPending}
      >
        <Text>{t('common.save')}</Text>
      </Button>
    </>
  );
}

/**
 * A placeholder line sized by the copy it stands in for. The hidden copy carries
 * the loaded line's own style — `text-sm font-medium`, which both the field's
 * label and the `Text` inside its reserved slot paint — so the bar is exactly as
 * tall as that line in every locale and at every text size; a different weight
 * would change the glyph advances and could wrap where the loaded line does not.
 */
function PlaceholderLine({ text, barClassName }: Readonly<{ text: string; barClassName: string }>) {
  return (
    <View>
      <View
        className="flex-row opacity-0"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text className="w-full shrink-0 text-sm font-medium">{text}</Text>
      </View>
      <View className="absolute inset-0">
        <Skeleton className={cn('h-full', barClassName)} />
      </View>
    </View>
  );
}

/**
 * The links on the account's public profile. Four states: the saved values load
 * behind skeletons sized to the two fields, a failed read keeps its retry, the
 * form is the happy path, and a refused save reports the server's own message.
 *
 * The name a person signed up with is not editable here: `updateProfile` has no
 * name field, and the account's name comes from the identity provider that
 * created it.
 */
export function ProfileEditScreen() {
  const { t } = useTranslation();
  // This route has one exit, whoever asks for it: the header's Back, the save's
  // completion, and a Save that changed nothing all leave through `popOnce`. The
  // route leaves once, and a press or completion that arrives while it is
  // already leaving is dropped — the reader's Back can still land on this
  // screen's header during the pop the completion started, and a second pop
  // would close Account settings beneath it.
  const popOnce = usePopOnce();
  const router = useRouter();
  // A relaunch, or a cold link, can render this route with nothing beneath it;
  // the header's Back then has no history to pop and lands on the Profile tab
  // root instead of unwinding the stack.
  const leaveScreen = useCallback(() => {
    if (router.canGoBack()) {
      popOnce();
      return;
    }
    router.dismissTo(PROFILE_TAB_HREF);
  }, [popOnce, router]);
  const trpc = useTRPC();
  const links = useQuery(trpc.user.getProfileLinks.queryOptions());

  let body: ReactNode = null;
  if (links.isPending) {
    // Each block holds the loaded field's geometry: the label line, the field's
    // own 44pt box (`INPUT_BOX_SHAPE_CLASS`) and the reserved message line; the
    // Save slot holds the button's own 48pt action frame (`STATE_ACTION_CLASS`).
    // A text bar is sized by the copy it stands in for, so a wrapped label or
    // message keeps the block as tall as the loaded one; a hand-sized bar would
    // drift from those boxes and move the body on swap.
    body = (
      <>
        <View className="gap-1.5">
          <View className="gap-1.5">
            <PlaceholderLine text={t('profile.editProfile.linkedinLabel')} barClassName="w-24" />
            <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, 'w-full')} />
          </View>
          <PlaceholderLine text={t('profile.editProfile.invalidUrl')} barClassName="w-40" />
        </View>
        <View className="gap-1.5">
          <View className="gap-1.5">
            <PlaceholderLine text={t('profile.editProfile.githubLabel')} barClassName="w-24" />
            <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, 'w-full')} />
          </View>
          <PlaceholderLine text={t('profile.editProfile.invalidUrl')} barClassName="w-40" />
        </View>
        <Skeleton className={cn(STATE_ACTION_CLASS, 'rounded-md')} />
      </>
    );
  } else if (links.isError) {
    body = <QueryError onRetry={() => void links.refetch()} isRetrying={links.isFetching} />;
  } else {
    body = (
      <ProfileLinkForm
        linkedinUrl={links.data.linkedinUrl}
        githubUrl={links.data.githubUrl}
        onDone={popOnce}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('profile.editProfile.title')}
        onBack={leaveScreen}
        backFallback={PROFILE_TAB_HREF}
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* The hint explains the fields, so the error state — whose body is only
            the retry — omits it. It stays outside the body swap, so the
            header-to-hint distance is the same while the fields load and once
            they land. */}
        {links.isError ? null : (
          <Text variant="muted">{t('profile.editProfile.emptyRemovesLink')}</Text>
        )}
        {body}
      </TabScreenScrollView>
    </View>
  );
}
