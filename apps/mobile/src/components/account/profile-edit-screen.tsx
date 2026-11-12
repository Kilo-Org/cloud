import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useTRPC } from '@/lib/trpc';

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
};

/**
 * The form itself, mounted only once the saved links have arrived: the fields are
 * uncontrolled (a ref per field, `defaultValue` for the initial text), so they
 * cannot be filled in by a query that settles after their first render.
 */
function ProfileLinkForm({ linkedinUrl, githubUrl }: FieldsProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const trpc = useTRPC();
  const linkedinRef = useRef(linkedinUrl ?? '');
  const githubRef = useRef(githubUrl ?? '');
  const [linkedinError, setLinkedinError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const validateUrl = createProfileUrlError(t('profile.editProfile.invalidUrl'));

  const update = useMutation(
    trpc.user.updateProfile.mutationOptions({
      onSuccess: () => {
        announcingToast.success(t('profile.editProfile.saved'));
        router.back();
      },
      // The server's message is the account of what it refused, so it is shown
      // as written rather than replaced with a generic failure.
      onError: error => toast.error(error.message),
    })
  );

  const onSubmit = () => {
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
      router.back();
      return;
    }
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
        disabled={update.isPending}
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
        disabled={update.isPending}
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
  const trpc = useTRPC();
  const links = useQuery(trpc.user.getProfileLinks.queryOptions());

  let body;
  if (links.isPending) {
    body = (
      <View className="gap-6">
        <Skeleton className="h-[74px] rounded-lg" />
        <Skeleton className="h-[74px] rounded-lg" />
        <Skeleton className="h-11 rounded-lg" />
      </View>
    );
  } else if (links.isError) {
    body = <QueryError onRetry={() => void links.refetch()} isRetrying={links.isFetching} />;
  } else {
    body = (
      <ProfileLinkForm linkedinUrl={links.data.linkedinUrl} githubUrl={links.data.githubUrl} />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.editProfile.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </TabScreenScrollView>
    </View>
  );
}
