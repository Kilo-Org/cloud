import { redirect } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import Link from 'next/link';
import { LANDING_URL } from '@/lib/constants';
import { getUserFromAuth, getProfileRedirectPath } from '@/lib/user/server';
import { PERSONAL_ACCOUNT_DISABLED_PATH } from '@/lib/personal-account';

export default async function PersonalAccountDisabledPage() {
  const user = (await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true }))
    ?.user;

  if (!user) {
    redirect('/users/sign_in');
  }

  // If the account is not actually disabled, or the user does have an
  // organization to land on, send them to their normal destination instead of
  // stranding them on the error page.
  if (!user.personal_account_disabled) {
    redirect('/profile');
  }
  const redirectPath = await getProfileRedirectPath(user);
  if (redirectPath !== PERSONAL_ACCOUNT_DISABLED_PATH) {
    redirect(redirectPath);
  }

  return (
    <div className="mt-16 flex w-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>No workspace available</CardTitle>
          <CardDescription>
            Your personal account is disabled and you are not a member of any organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Contact your administrator</AlertTitle>
            <AlertDescription>
              <p>
                Access to Kilo is managed by your organization. Ask an organization owner to add you
                to an organization, or{' '}
                <Link href={`${LANDING_URL}/support`} className="underline">
                  contact support
                </Link>{' '}
                if you believe this is an error.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
