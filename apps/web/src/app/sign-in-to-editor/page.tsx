import { OpenCodeEditor } from '@/components/auth/OpenCodeEditor';
import { DelayedLinks } from '@/components/auth/DelayedLinks';
import { getExtensionUrl } from '@/components/auth/getExtensionUrl';
import { generateApiToken } from '@/lib/tokens';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { KiloCardLayout } from '@/components/KiloCardLayout';
import { ManualSetupSteps } from '@/components/auth/ManualSetupSteps';
import { OpenIdeAutomatically } from '@/components/auth/OpenIdeAutomatically';

export default async function RedirectPage({
  searchParams,
}: {
  searchParams: NextAppSearchParamsPromise;
}) {
  const { extensionUrl, ideName, urlScheme, logoSrc } = getExtensionUrl(
    await searchParams,
    await cookies()
  );
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/sign-in-to-editor');

  if (user.has_validation_stytch === null) {
    // account-status does stytch verification and redirects to welcome when that's done
    redirect('/account-verification');
  }

  const kiloToken = generateApiToken(user);
  const url = `${extensionUrl}?token=${kiloToken}`;

  if (urlScheme === 'web') {
    return (
      <KiloCardLayout title="Web IDE Authentication">
        <ManualSetupSteps kiloToken={kiloToken} />
        <div className="mt-8">
          <DelayedLinks />
        </div>
      </KiloCardLayout>
    );
  }

  return (
    <>
      <OpenCodeEditor url={url} />
      <KiloCardLayout contentClassName="">
        <OpenIdeAutomatically url={url} ideName={ideName} logoSrc={logoSrc} kiloToken={kiloToken} />
        <div className="mt-4">
          <DelayedLinks />
        </div>
      </KiloCardLayout>
    </>
  );
}
