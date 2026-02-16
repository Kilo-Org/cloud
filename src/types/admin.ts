import * as z from 'zod';
import type {
  UserAdminNote,
  User,
  Organization,
  OrganizationMembership,
  AutoTopUpConfig,
} from '@/db/schema';
import type { describePaymentMethods } from '@/lib/admin-utils-serverside';
import { OrganizationSchema } from '@/lib/organizations/organization-types';
import { type BalanceForUser } from '@/lib/user.balance';
import type { PaginationMetadata } from '@/types/pagination';

export type PaymentMethodStatus = Awaited<ReturnType<typeof describePaymentMethods>>;

export type HasPaymentStatus = {
  paymentMethodStatus: PaymentMethodStatus;
};
export type HasCreditInfo = {
  creditInfo: BalanceForUser;
};
// Shared UserDetailProps type for components that need the full user object
export type UserTableProps = User &
  HasPaymentStatus & { is_blacklisted_by_domain: boolean; admin_notes: NoteWithAdminUser[] };
export type UserOrganizationMembershipProps = {
  organization_memberships: {
    membership: OrganizationMembership;
    organization: Organization;
  }[];
};

export type HasAutoTopUpConfig = {
  autoTopUpConfig: AutoTopUpConfig | null;
};
export type HasSSOProtectedDomain = {
  is_sso_protected_domain: boolean;
};
export type UserDetailProps = UserTableProps &
  HasCreditInfo &
  UserOrganizationMembershipProps &
  HasAutoTopUpConfig &
  HasSSOProtectedDomain;
export type UsersApiResponse = {
  users: UserTableProps[];
  pagination: PaginationMetadata;
};

export const AdminOrganizationSchema = OrganizationSchema.extend({
  member_count: z.number(),
  created_by_user_email: z.string().nullable(),
  created_by_user_name: z.string().nullable(),
  subscription_amount_usd: z.number().nullable(),
});

export const OrganizationsApiGetResponseSchema = z.object({
  organizations: z.array(AdminOrganizationSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

export type NoteWithAdminUser = UserAdminNote & { admin_kilo_user: User | null };

export interface AddCreditRequest {
  email: string;
  // Conventional names (preferred)
  amount_usd?: number | null;
  description?: string | null;
  credit_category?: string;
  credit_expiry_date?: string;
  expiry_hours?: number | null;
  // Legacy names (for backward compatibility)
  // ref, e.g.: https://www.val.town/x/kilocode/stream-github-superstars/code/issue-credits.ts is still using old names.
  creditAmount?: number | null;
  creditDescription?: string | null;
  idempotencyKey?: string;
  creditExpiryDate?: string;
  creditExpiryHours?: number | null;
}

export const sortableFields = [
  'google_user_email',
  'created_at',
  'updated_at',
  'microdollars_used',
  'total_microdollars_acquired',
] as const;

export type SortableField = (typeof sortableFields)[number];

export const ascendingFirstFields: SortableField[] = ['google_user_email'];

export type OrganizationSortableField =
  | 'name'
  | 'created_at'
  | 'microdollars_used'
  | 'microdollars_balance'
  | 'member_count';

export type CreditCategorySortableField =
  | 'credit_category'
  | 'is_user_selfservicable'
  | 'promotion_ends_at'
  | 'first_used_at'
  | 'last_used_at'
  | 'user_count'
  | 'blocked_user_count'
  | 'credit_count'
  | 'total_dollars'
  | 'user_count_last_week'
  | 'credit_count_last_week'
  | 'total_dollars_last_week';

export type CreditCategorySortConfig = {
  field: CreditCategorySortableField;
  direction: 'asc' | 'desc';
};

export type SortConfig = {
  field: SortableField;
  direction: 'asc' | 'desc';
};
