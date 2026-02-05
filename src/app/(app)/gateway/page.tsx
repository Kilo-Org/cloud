import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Key } from 'lucide-react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { generateApiToken } from '@/lib/tokens';
import { CopyTokenButton } from '@/components/auth/CopyTokenButton';
import { ResetAPITokenDialog } from '@/components/profile/ResetAPITokenDialog';
import { PageLayout } from '@/components/PageLayout';

export default async function GatewayPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gateway');
  const kiloToken = generateApiToken(user);

  return (
    <PageLayout title="Gateway">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            API Key
          </CardTitle>
          <CardDescription>
            Use this API key to authenticate with the Kilo Code Gateway.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyTokenButton kiloToken={kiloToken} />
          <div className="flex justify-end">
            <ResetAPITokenDialog />
          </div>
        </CardContent>
      </Card>
    </PageLayout>
  );
}
