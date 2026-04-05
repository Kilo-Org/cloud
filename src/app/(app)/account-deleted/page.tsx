import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle } from 'lucide-react';
import { LinkButton } from '@/components/Button';

export default function AccountDeletedPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl grow flex-col items-center justify-center">
      <Card className="w-full rounded-xl shadow-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-950">
            <CheckCircle className="h-10 w-10 text-green-400" />
          </div>
          <CardTitle className="text-2xl">Account Successfully Deleted</CardTitle>
          <CardDescription className="mt-2 text-base">
            Your account has been permanently removed from our system.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-muted-foreground">
            We&apos;re sorry to see you go. If you change your mind, you&apos;re always welcome to
            create a new account.
          </p>
          <div className="pt-4">
            <LinkButton href="/" variant="primary" size="lg">
              Return to Homepage
            </LinkButton>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
