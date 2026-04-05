import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UserAdminDashboard } from '@/app/admin/components/UserAdmin/UserAdminDashboard';
import type { UserDetailProps } from '@/types/admin';
import { getUserFromAuth, isUserBlacklistedByDomain } from '@/lib/user.server';
import { getPaymentStatusByUserIds, describePaymentMethods } from '@/lib/admin-utils-serverside';
import { db } from '@/lib/drizzle';
import type { PaymentMethod } from '@kilocode/db/schema';
import {
  kilocode_users,
  user_admin_notes,
  organization_memberships,
  organizations,
  auto_top_up_configs,
} from '@kilocode/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { findUserById } from '@/lib/user';
import { getBalanceForUser } from '@/lib/user.balance';
import { hasReceivedAnyFreeWelcomeCredits } from '@/lib/welcomeCredits';
import { redirect } from 'next/navigation';
import { doesOrgWithSSODomainExist } from '@/lib/organizations/organizations';
import { getLowerDomainFromEmail } from '@/lib/utils';

async function getUserData(userId: string): Promise<UserDetailProps | null> {
  const user = await findUserById(userId);

  if (!user) {
    return null;
  }

  const notes = await db.query.user_admin_notes.findMany({
    where: eq(user_admin_notes.kilo_user_id, userId),
    orderBy: desc(user_admin_notes.created_at),
  });

  const adminIds = notes.map(note => note.admin_kilo_user_id).filter(id => id != null);

  const admins =
    adminIds.length > 0
      ? await db.query.kilocode_users.findMany({
          where: inArray(kilocode_users.id, adminIds),
          limit: 50,
        })
      : [];

  const adminsById = new Map(admins.map(admin => [admin.id, admin]));

  const notesWithAdmin = notes.map(note => ({
    ...note,
    admin_kilo_user: note.admin_kilo_user_id
      ? (adminsById.get(note.admin_kilo_user_id) ?? null)
      : null,
  }));

  // Fetch organization memberships with organization details
  const organizationMemberships = await db
    .select({
      membership: organization_memberships,
      organization: organizations,
    })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organization_memberships.organization_id, organizations.id))
    .where(eq(organization_memberships.kilo_user_id, userId))
    .orderBy(desc(organization_memberships.joined_at));

  const paymentMethodsByUserId = await getPaymentStatusByUserIds([user.id]);
  const creditInfo = await getBalanceForUser(user);
  const hasReceivedCardValidationCredits = await hasReceivedAnyFreeWelcomeCredits(user.id);

  // Fetch auto-top-up config
  const autoTopUpConfig =
    (await db.query.auto_top_up_configs.findFirst({
      where: eq(auto_top_up_configs.owned_by_user_id, userId),
    })) ?? null;

  // Check if user's email domain has SSO configured
  const emailDomain = getLowerDomainFromEmail(user.google_user_email);
  const isSSOProtectedDomain = emailDomain
    ? !!(await doesOrgWithSSODomainExist(emailDomain))
    : false;

  return {
    ...user,
    paymentMethodStatus: describePaymentMethods(
      (paymentMethodsByUserId[user.id] as PaymentMethod[]) || [],
      user,
      hasReceivedCardValidationCredits
    ),
    creditInfo,
    admin_notes: notesWithAdmin,
    is_blacklisted_by_domain: isUserBlacklistedByDomain({
      google_user_email: user.google_user_email,
    }),
    organization_memberships: organizationMemberships,
    autoTopUpConfig,
    is_sso_protected_domain: isSSOProtectedDomain,
  };
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Check authentication first
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const userId = decodeURIComponent(id);

  const user = await getUserData(userId);

  if (!user) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>User Not Found</CardTitle>
          <CardDescription>The requested user could not be found</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            The user with ID &quot;{userId}&quot; does not exist or you don&apos;t have permission
            to view it.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <UserAdminDashboard {...user} />;
}
