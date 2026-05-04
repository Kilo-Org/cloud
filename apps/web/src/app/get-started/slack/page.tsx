import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import { getAuthPageProps } from '@/lib/auth/auth-page-wrapper';
import { AuthPageLayout } from '@/components/auth/AuthPageLayout';
import { SignInForm } from '@/components/auth/SignInForm';
import { allow_fake_login } from '@/lib/constants';
import { SlackGetStartedFlow } from './_components/SlackGetStartedFlow';

function buildSlackGetStartedCallbackPath(params: Record<string, string>): string {
  const callbackParams = new URLSearchParams();

  for (const key of ['installToken', 'source']) {
    const value = params[key];
    if (value) callbackParams.set(key, value);
  }

  const query = callbackParams.toString();
  return query ? `/get-started/slack?${query}` : '/get-started/slack';
}

export default async function GetStartedSlackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });
  const params = await searchParams;
  const callbackPath = buildSlackGetStartedCallbackPath(params);

  // If user is not authenticated, show sign-up form
  if (!user) {
    const { error } = await getAuthPageProps(Promise.resolve(params));
    return (
      <AuthPageLayout>
        <div className="mt-4 flex flex-col items-center">
          <SignInForm
            searchParams={{ ...params, callbackPath }}
            error={error}
            isSignUp={true}
            allowFakeLogin={allow_fake_login}
            title="Get Started with Kilo for Slack"
            subtitle="Sign up to connect Kilo to your Slack workspace and start chatting with AI directly from Slack."
          />
        </div>
      </AuthPageLayout>
    );
  }

  if (user.has_validation_stytch === null) {
    redirect(`/account-verification?callbackPath=${encodeURIComponent(callbackPath)}`);
  }

  return (
    <SlackGetStartedFlow
      installToken={params.installToken}
      source={params.source}
      slackSuccess={params.slackSuccess}
      slackError={params.slackError}
    />
  );
}
