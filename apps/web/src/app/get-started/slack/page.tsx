import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import { getAuthPageProps } from '@/lib/auth/auth-page-wrapper';
import { AuthPageLayout } from '@/components/auth/AuthPageLayout';
import { SignInForm } from '@/components/auth/SignInForm';
import { allow_fake_login } from '@/lib/constants';
import { SlackGetStartedFlow } from './_components/SlackGetStartedFlow';

export default async function GetStartedSlackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });

  // If user is not authenticated, show sign-up form
  if (!user) {
    const { params, error } = await getAuthPageProps(searchParams);
    return (
      <AuthPageLayout>
        <div className="mt-4 flex flex-col items-center">
          <SignInForm
            searchParams={{ ...params, callbackPath: '/get-started/slack' }}
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
    redirect('/account-verification?callbackPath=/get-started/slack');
  }

  return <SlackGetStartedFlow />;
}
