import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Plus } from 'lucide-react';

export function NewOrganizationCard() {
  return (
    <Link href="/organizations/new" className="block">
      <Card className="hover:border-primary/20 border-2 border-dashed transition-shadow duration-200 hover:shadow-md">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="shrink-0">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg border-2 border-green-200 bg-linear-to-br from-green-50 to-emerald-50">
                  <Plus className="h-6 w-6 text-green-600" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-foreground text-lg font-semibold">Create New Organization</h3>
                <p className="text-muted-foreground mt-1 text-sm">
                  Set up a new organization to collaborate with your team
                </p>
              </div>
            </div>
            <div className="text-muted-foreground flex items-center">
              <span className="text-sm">Get started →</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
