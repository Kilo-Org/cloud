'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { UserDetailProps } from '@/types/admin';
import type { GuiCreditCategory } from '@/lib/PromoCreditCategoryConfig';
import { UserAdminCreditGrant } from './UserAdminCreditGrant';
import { UserAdminCreditTransactions } from './UserAdminCreditTransactions';
import { UserAdminPaymentMethods } from './UserAdminPaymentMethods';
import { UserAdminUsageBilling } from './UserAdminUsageBilling';
import { UserAdminAccountInfo } from './UserAdminAccountInfo';
import { UserAdminNotes } from './UserAdminNotes';
import { UserAdminGdprRemoval } from './UserAdminGdprRemoval';
import { UserAdminReferrals } from './UserAdminReferrals';
import { UserAdminStytchFingerprints } from './UserAdminStytchFingerprints';
import { UserAdminInvoices } from './UserAdminInvoices';
import { UserAdminOrganizations } from './UserAdminOrganizations';
import { UserAdminKiloPass } from './UserAdminKiloPass';
import { UserAdminKiloClaw } from './UserAdminKiloClaw';
import { UserAdminGastown } from './UserAdminGastown';

const VALID_TABS = ['billing', 'organizations', 'kiloclaw', 'gastown', 'admin-tools'] as const;
type Tab = (typeof VALID_TABS)[number];
const isValidTab = (value: string | null): value is Tab =>
  value !== null && (VALID_TABS as readonly string[]).includes(value);

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function UserAdminTabbedSections(
  user: UserDetailProps & { promoCreditCategories: readonly GuiCreditCategory[] }
) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const tabParam = searchParams.get('tab');
  const activeTab: Tab = isValidTab(tabParam) ? tabParam : 'billing';

  const onTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'billing') {
        params.delete('tab');
      } else {
        params.set('tab', value);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Account info — always visible above the tabs */}
      <UserAdminAccountInfo {...user} />

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
          <TabsTrigger value="billing" className={tabTriggerClass}>
            Billing
          </TabsTrigger>
          <TabsTrigger value="organizations" className={tabTriggerClass}>
            Organizations
          </TabsTrigger>
          <TabsTrigger value="kiloclaw" className={tabTriggerClass}>
            KiloClaw
          </TabsTrigger>
          <TabsTrigger value="gastown" className={tabTriggerClass}>
            Gas Town
          </TabsTrigger>
          <TabsTrigger value="admin-tools" className={tabTriggerClass}>
            Admin Tools
          </TabsTrigger>
        </TabsList>

        <TabsContent value="billing" className="mt-4">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
            <UserAdminUsageBilling {...user} />
            <UserAdminCreditGrant {...user} promoCreditCategories={user.promoCreditCategories} />
            <UserAdminCreditTransactions {...user} />
            <UserAdminPaymentMethods {...user} />
            <UserAdminInvoices stripe_customer_id={user.stripe_customer_id} />
            <UserAdminKiloPass userId={user.id} />
          </div>
        </TabsContent>

        <TabsContent value="organizations" className="mt-4">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
            <UserAdminOrganizations organization_memberships={user.organization_memberships} />
          </div>
        </TabsContent>

        <TabsContent value="kiloclaw" className="mt-4">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
            <UserAdminKiloClaw userId={user.id} />
          </div>
        </TabsContent>

        <TabsContent value="gastown" className="mt-4">
          <UserAdminGastown userId={user.id} />
        </TabsContent>

        <TabsContent value="admin-tools" className="mt-4">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <UserAdminNotes {...user} />
            <UserAdminStytchFingerprints {...user} />
            <UserAdminReferrals kilo_user_id={user.id} />
            <UserAdminGdprRemoval {...user} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
