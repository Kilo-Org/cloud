import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900">
      <Card className="p-8 text-center">
        <h1 className="mb-4 text-2xl font-bold">Access Denied</h1>
        <p className="mb-6 text-gray-400">
          You do not have administrative privileges to access this page.
        </p>
        <Link href="/">
          <Button>Go Home</Button>
        </Link>
      </Card>
    </div>
  );
}
