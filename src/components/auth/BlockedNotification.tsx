import { Ban } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import Link from 'next/link';
import { LANDING_URL } from '@/lib/constants';

export function BlockedNotification() {
  return (
    <div className="mt-16 flex w-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Account Blocked</CardTitle>
          <CardDescription>Your access to our services has been restricted.</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <Ban className="h-4 w-4" />
            <AlertTitle>Violation of Terms of Service</AlertTitle>
            <AlertDescription>
              <p>
                Our records indicate that your account has engaged in activities that violate our{' '}
                <Link href={`${LANDING_URL}/terms`} className="underline">
                  terms
                </Link>
                . If you believe this is an error, please contact our support team.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          <Link href={`${LANDING_URL}/support`} className="w-full">
            <div className="border-input hover:bg-accent hover:text-accent-foreground w-full rounded-md border bg-transparent px-4 py-2 text-center">
              Contact Support
            </div>
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
