import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AutoRoutingModeCard } from '@/components/auto-routing/AutoRoutingModeCard';
import { AutoTopUpToggle } from '@/components/payment/AutoTopUpToggle';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { PageLayout } from '@/components/PageLayout';
import Link from 'next/link';
import {
  Coins,
  FileDown,
  Key,
  Plug,
  Receipt,
  Sparkles,
  User,
} from 'lucide-react';
import type { ElementType } from 'react';

const NAV_LINKS: Array<{
  href: string;
  title: string;
  description: string;
  icon: ElementType;
}> = [
  {
    href: '/profile',
    title: 'Your Profile',
    description: 'Edit your name, photo, and social links',
    icon: User,
  },
  {
    href: '/connected-accounts',
    title: 'Connected Accounts',
    description: 'Manage login methods',
    icon: Plug,
  },
  {
    href: '/data-exports',
    title: 'Data Exports',
    description: 'Request data export or deletion',
    icon: FileDown,
  },
  {
    href: '/byok',
    title: 'Bring Your Own Key',
    description: 'Bring your own API keys',
    icon: Key,
  },
  {
    href: '/credits',
    title: 'Credits',
    description: 'Purchase credits and view history',
    icon: Coins,
  },
  {
    href: '/invoices',
    title: 'Invoices',
    description: 'Billing invoices',
    icon: Receipt,
  },
  {
    href: '/subscriptions',
    title: 'Subscriptions',
    description: 'Manage subscriptions',
    icon: Sparkles,
  },
];

export default async function SettingsPage() {
  await getUserFromAuthOrRedirect('/users/sign_in');

  return (
    <PageLayout title="Settings">
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

      <AutoRoutingModeCard />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {NAV_LINKS.map(link => {
          const Icon = link.icon;
          return (
            <Link key={link.href} href={link.href} className="block">
              <Card className="hover:border-primary/20 h-full transition-shadow duration-200 hover:shadow-md">
                <CardContent className="flex h-full items-start gap-3 p-4">
                  <div className="bg-primary/10 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                    <Icon className="text-primary h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground font-semibold">{link.title}</p>
                    <p className="text-muted-foreground mt-1 text-sm">{link.description}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </PageLayout>
  );
}
