import type { PaginationMetadata } from '@/types/pagination';
import { millisecondsInHour } from 'date-fns/constants';
import { APP_URL } from '@/lib/constants';
import type { CustomerRequirement } from '@/lib/promoCustomerRequirement';
import type { OrganizationRequirement } from '@/lib/organizations/organizationRequirement';

export type CreditTransactionWithUser = {
  kilo_user_id: string;
  credit_transaction_id: string;
  google_user_image_url: string;
  google_user_name: string;
  google_user_email: string;
  created_at: string;
  microdollars_used: number;
  is_admin: boolean;
  transaction_amount: number;
  transaction_date: string;
  paymentMethodStatus: string;
};

type PromoCreditCategoryConfigCore = {
  credit_category: string;
  adminUI_label?: string;
  amount_usd?: number;
  description?: string;
  credit_expiry_date?: Date;
  expiry_hours?: number;
  obsolete?: boolean;
  total_redemptions_allowed?: number;
  is_idempotent?: boolean;
  promotion_ends_at?: Date;
  customer_requirement?: CustomerRequirement;
  organization_requirement?: OrganizationRequirement;
  expect_negative_amount?: boolean;
};

export type NonSelfServicePromoCreditCategoryConfig = PromoCreditCategoryConfigCore & {
  is_user_selfservicable?: false;
};

export type SelfServicePromoCreditCategoryConfig = PromoCreditCategoryConfigCore & {
  is_user_selfservicable: true;
  is_idempotent: true;
  total_redemptions_allowed: number;
  amount_usd: number;
};

export type PromoCreditCategoryConfig =
  | NonSelfServicePromoCreditCategoryConfig
  | SelfServicePromoCreditCategoryConfig;

export type GuiCreditCategory = Omit<
  PromoCreditCategoryConfig,
  'customer_requirement' | 'organization_requirement'
> & {
  customer_requirement_name: string | undefined;
  organization_requirement_name: string | undefined;
};

export function toGuiCreditCategory(config: PromoCreditCategoryConfig): GuiCreditCategory {
  const { customer_requirement, organization_requirement, ...rest } = config;
  return {
    customer_requirement_name: customer_requirement?.name,
    organization_requirement_name: organization_requirement?.name,
    ...rest,
  };
}

export type GuiCreditCategoryStatistics = GuiCreditCategory & {
  user_count: number;
  credit_count: number;
  total_dollars: number;
  user_count_last_week: number;
  credit_count_last_week: number;
  total_dollars_last_week: number;
  first_used_at: Date | null;
  last_used_at: Date | null;
  blocked_user_count: number;
};

export type CreditCategoriesApiResponse = {
  creditCategories: GuiCreditCategoryStatistics[];
  pagination?: PaginationMetadata;
};

export type CreditCategoryUsersApiResponse = {
  creditCategory: GuiCreditCategory;
  users: CreditTransactionWithUser[];
  pagination: PaginationMetadata;
};

// Helper function to calculate effective expiry date
function getEffectiveExpiryDate(category: PromoCreditCategoryConfig): Date | null {
  if (category.credit_expiry_date) {
    return category.credit_expiry_date;
  }
  if (category.promotion_ends_at && category.expiry_hours) {
    return new Date(
      category.promotion_ends_at.getTime() + category.expiry_hours * millisecondsInHour
    );
  }
  if (category.promotion_ends_at) {
    return category.promotion_ends_at;
  }
  return null;
}

// Helper function to format a category as markdown
export function formatCategoryAsMarkdown(category: GuiCreditCategory): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`## \`${category.credit_category}\``);
  if (category.description) lines.push(category.description);
  lines.push('');

  lines.push(` - Idempotent: **${category.is_idempotent ? 'YES' : 'NO'}**`);
  lines.push(` - User self-service: **${category.is_user_selfservicable ? 'YES' : 'NO'}**`);

  lines.push(
    category.adminUI_label
      ? ` - Show in Admin UI as: **${category.adminUI_label}**`
      : ' - Not designed to be granted in the admin panel'
  );

  lines.push(` - Amount: **$${category.amount_usd ?? 'NO DEFAULT AMOUNT'}**`);

  if (category.credit_expiry_date) {
    lines.push(` - Credit Expiry Date: **${category.credit_expiry_date.toISOString()}**`);
  }
  if (category.expiry_hours) {
    lines.push(
      ` - Credit Expiry (sliding window): **${category.expiry_hours} hours (${category.expiry_hours / 24} days)**`
    );
  }
  if (category.promotion_ends_at) {
    lines.push(` - Promotion Ends At: **${category.promotion_ends_at.toISOString()}**`);
  }
  if (category.total_redemptions_allowed) {
    lines.push(` - Total Redemptions Allowed: **${category.total_redemptions_allowed}**`);
  }
  if (category.customer_requirement_name) {
    lines.push(` - Customer Requirement: **${category.customer_requirement_name}**`);
  }

  return lines.join('\n');
}

// Helper function to generate markdown documentation for promo credit categories
export function generatePromoCreditCategoriesMarkdown(
  promoCreditCategories: readonly PromoCreditCategoryConfig[]
): string {
  // Sort by expiry date (later expiry first, null/undefined at top)
  const sortedCategories = [...promoCreditCategories].sort((a, b) => {
    const aExpiry = getEffectiveExpiryDate(a);
    const bExpiry = getEffectiveExpiryDate(b);

    // No expiry goes to top
    if (!aExpiry && !bExpiry) return 0;
    if (!aExpiry) return -1;
    if (!bExpiry) return 1;

    // Later expiry first
    return bExpiry.getTime() - aExpiry.getTime();
  });

  // Group categories
  const userSelfserviceable: PromoCreditCategoryConfig[] = [];
  const adminUILabel: PromoCreditCategoryConfig[] = [];
  const idempotent: PromoCreditCategoryConfig[] = [];
  const rest: PromoCreditCategoryConfig[] = [];

  for (const category of sortedCategories) {
    if (category.is_user_selfservicable) {
      userSelfserviceable.push(category);
    } else if (category.adminUI_label) {
      adminUILabel.push(category);
    } else if (category.is_idempotent) {
      idempotent.push(category);
    } else {
      rest.push(category);
    }
  }

  // Generate markdown content
  const markdownContent = [
    '# Promotional Credit Categories',
    '',
    '**NOTE:** this document is auto-generated!',
    '',
    'These credit categories describe how we can grant users free credits.',
    "Each credit category has a unqiue code and a number of simple rules that apply to those credits (e.g. whether it's the support team or the user applying the code, or whether the code is idempotent and thus can be used only once).",
    `You can see how many credits were granted to which account in our admin panel: ${APP_URL}/admin/credit-categories`,
    '',
    '## User Selfserviceable Categories',
    '',
    'These categories are particularly vulnerable to abuse since users can share codes.',
    '',
    ...userSelfserviceable.map(toGuiCreditCategory).map(formatCategoryAsMarkdown),
    '',
    '## Support team (i.e. Admin UI) Categories',
    '',
    `These categories are exposed to be interactively added via the ${APP_URL}/admin/users user admin panel for support cases.`,
    '',
    ...adminUILabel.map(toGuiCreditCategory).map(formatCategoryAsMarkdown),
    '',
    '## Idempotent API Categories',
    '',
    `These categories can be applied just once from our codebase or by externally (e.g. valtown, customer.io) using the ${APP_URL}/admin/api/users/add-credit endpoint with an admin user JWT.`,
    "They're not available in the support UI nor user-selfservicable.",
    '',
    ...idempotent.map(toGuiCreditCategory).map(formatCategoryAsMarkdown),
    '',
    '## Other Categories',
    '',
    `These categories can be applied multiple times from our codebase or by externally (e.g. valtown, customer.io) using the ${APP_URL}/admin/api/users/add-credit endpoint with an admin user JWT.`,
    "They're not available in the support UI nor user-selfservicable.",
    '',
    ...rest.map(toGuiCreditCategory).map(formatCategoryAsMarkdown),
    '',
  ].join('\n');
  return markdownContent;
}
