import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function OrganizationGuardrailsCard({ organizationId }: { organizationId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Guardrails</CardTitle>
        <CardDescription>Add oversight and protections for AI usage</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <Link href={`/organizations/${organizationId}/guardrails`}>Configure guardrails</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
