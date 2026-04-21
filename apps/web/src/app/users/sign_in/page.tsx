import { allow_fake_login } from '@/lib/constants';
import { getAuthPageProps } from '@/lib/auth/auth-page-wrapper';
import { AuthPageLayout } from '@/components/auth/AuthPageLayout';
import { SignInForm } from '@/components/auth/SignInForm';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { params, error } = await getAuthPageProps(searchParams);
  const ssoMode = params['sso'] === 'true' || !!params['domain'];
  const isSignUp = params['signup'] === 'true';

  return (
    <AuthPageLayout>
      <div className="mt-4 flex flex-col items-center">
        <SignInForm
          searchParams={params}
          error={error}
          isSignUp={isSignUp}
          allowFakeLogin={allow_fake_login}
          title={
            ssoMode
              ? 'Enterprise SSO'
              : isSignUp
                ? 'Create your Kilo Code account'
                : 'Welcome to Kilo Code'
          }
          subtitle={
            ssoMode
              ? "Enter your work email address to sign in with your organization's Single Sign-On"
              : isSignUp
                ? 'Sign up to get started'
                : 'Sign in or create an account to get started'
          }
          ssoMode={ssoMode}
          emailOnly={ssoMode}
        />
      </div>
    </AuthPageLayout>
  );
}
