import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Wrench } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import ProfileCreditsCounter from '@/components/profile/ProfileCreditsCounter';
import ProfileExpiringCredits from '@/components/profile/ProfileExpiringCredits';
import { getCustomerInfo } from '@/lib/customerInfo';
import { DevNukeAccountButton } from '@/components/dev/DevNukeAccountButton';
import { DevConsumeCreditsButton } from '@/components/dev/DevConsumeCreditsButton';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { getExtensionUrl } from '@/components/auth/getExtensionUrl';
import { cookies } from 'next/headers';
import CreditPurchaseOptions from '@/components/payment/CreditPurchaseOptions';

import { Coins } from 'lucide-react';
import { SurveyCredits } from '@/components/SurveyCredits';
import { RedeemPromoCode } from '@/components/profile/RedeemPromoCode';
import { AutoTopUpToggle } from '@/components/payment/AutoTopUpToggle';
import { IntegrationsCard } from '@/components/profile/IntegrationsCard';
import { getUserOrganizationsWithSeats } from '@/lib/organizations/organizations';
import { PageLayout } from '@/components/PageLayout';
import { ProfileOrganizationsSection } from '@/components/profile/ProfileOrganizationsSection';
import { ProfileKiloPassSection } from '@/components/profile/ProfileKiloPassSection';
import { CreateKilocodeOrgButton } from '@/components/dev/CreateKilocodeOrgButton';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { UserProfileCard } from '@/components/profile/UserProfileCard';

export default async function ProfilePage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const params = await searchParams;
  const customerInfo = await getCustomerInfo(user, params);

  const isDevelopment = process.env.NODE_ENV === 'development';
  const isKiloPassUiEnabled =
    isDevelopment || (await isFeatureFlagEnabled('kilo-pass-ui', user.id));

  const { ideName, logoSrc } = getExtensionUrl(params, await cookies());
  const orgs = customerInfo.hasOrganizations ? await getUserOrganizationsWithSeats(user.id) : [];

  const remainingCreditsText = customerInfo.hasOrganizations
    ? 'Remaining Personal Credits'
    : 'Remaining Credits';
  return (
    <>
      {/* NOTE: When making changes to this structure, make sure to also update the structure in the loading.tsx file */}
      <PageLayout title="Profile">
        <div className="flex w-full flex-col gap-4 lg:flex-row">
          <Card className="flex-1 rounded-xl shadow-sm">
            <CardContent className="p-6">
              <UserProfileCard
                name={user.google_user_name}
                email={user.google_user_email}
                imageUrl={user.google_user_image_url}
                linkedinUrl={user.linkedin_url ?? null}
                githubUrl={user.github_url ?? null}
              />
            </CardContent>
          </Card>

          <Card className="flex-1 rounded-xl shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle>{remainingCreditsText}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ProfileCreditsCounter />
              <ProfileExpiringCredits />
            </CardContent>
          </Card>
        </div>

        {isKiloPassUiEnabled && <ProfileKiloPassSection />}

        <ProfileOrganizationsSection orgs={orgs} />

        <div className="flex w-full flex-col gap-4 xl:flex-row xl:items-stretch">
          <div className="flex-3">
            <CreditPurchaseOptions
              isFirstPurchase={!customerInfo.hasPaid}
              showOrganizationWarning={customerInfo.hasOrganizations}
            />
          </div>
        </div>

        <Card className="w-full text-left">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-5 w-5" />
              Automatic Top Up
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AutoTopUpToggle />
          </CardContent>
        </Card>

        {params.source && (
          <IntegrationsCard
            customerInfo={customerInfo}
            ideName={ideName}
            logoSrc={logoSrc}
            isProminent={true}
          />
        )}

        <SurveyCredits {...customerInfo} />

        <RedeemPromoCode />

        {!params.source && (
          <IntegrationsCard
            customerInfo={customerInfo}
            ideName={ideName}
            logoSrc={logoSrc}
            isProminent={false}
          />
        )}

        {/* <Card className="w-full rounded-xl border-red-200 shadow">
          <CardHeader>
            <CardTitle className="mb-2 flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              Danger
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex max-w-[272px] flex-col gap-2">
              <DeleteAccountDialog />
            </div>
          </CardContent>
        </Card> */}

        {process.env.NODE_ENV === 'development' && process.env.DEBUG_SHOW_DEV_UI && (
          <Card className="w-full rounded-xl border-red-800 bg-red-950/50 shadow lg:w-1/2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-200">
                <Wrench className="h-5 w-5" />
                Development Tools
              </CardTitle>
              <CardDescription className="text-red-300">
                These tools are only available in development mode.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <p className="text-muted-foreground text-sm font-medium">Consume Credits</p>
                  <DevConsumeCreditsButton />
                </div>
                <Separator />
                <div className="flex flex-col gap-2">
                  <CreateKilocodeOrgButton />
                </div>
                <Separator />
                <div className="flex flex-col gap-2">
                  <p className="text-muted-foreground text-sm font-medium">Danger Zone</p>
                  <DevNukeAccountButton kiloUserId={user.id} />
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </PageLayout>
    </>
  );
}
