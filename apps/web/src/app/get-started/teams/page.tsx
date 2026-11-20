import { GetStartedPage } from '@/components/auth/GetStartedPage';
import { getAuthPageProps } from '@/lib/auth/auth-page-wrapper';
import { FIRST_ORGANIZATION_TRIAL_OFFER } from '@/lib/organization-trial-offer';

type GetStartedPageProps = {
  searchParams: Promise<Record<string, string>>;
};

export default async function TeamsGetStartedPage({ searchParams }: GetStartedPageProps) {
  const { params, error, accountMismatch } = await getAuthPageProps(
    searchParams,
    '/organizations/new'
  );

  return (
    <>
      <GetStartedPage
        title="Get Started with Kilo Teams"
        callbackPath="/organizations/new"
        searchParams={params}
        error={error}
        accountMismatch={accountMismatch}
        signUpText={`Try out Kilo Teams, no credit card required. ${FIRST_ORGANIZATION_TRIAL_OFFER} After you sign up, you can directly onboard all your team members.`}
      />
    </>
  );
}
