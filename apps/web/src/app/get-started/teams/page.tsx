import { GetStartedPage } from '@/components/auth/GetStartedPage';
import { getAuthPageProps } from '@/lib/auth/auth-page-wrapper';
import { isAppleSignInEnabled } from '@/lib/auth/apple-feature-flag';

type GetStartedPageProps = {
  searchParams: Promise<Record<string, string>>;
};

export default async function TeamsGetStartedPage({ searchParams }: GetStartedPageProps) {
  const [{ params, error }, appleSignInEnabled] = await Promise.all([
    getAuthPageProps(searchParams, '/organizations/new'),
    isAppleSignInEnabled(),
  ]);

  return (
    <>
      <GetStartedPage
        title="Get Started with Kilo Teams"
        callbackPath="/organizations/new"
        searchParams={params}
        error={error}
        signUpText="Try out Kilo Teams with a 14-day free trial, no credit card required. After you sign up, you can directly onboard all your team members."
        appleSignInEnabled={appleSignInEnabled}
      />
    </>
  );
}
