import type { CustomerInfo } from '@/lib/customerInfo';
import PostHogClient from '@/lib/posthog';
import { has_used1usd_andHoldOrPayment } from '@/lib/promoCustomerRequirement';
import { db } from '@/lib/drizzle';
import { credit_transactions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

const SURVEY_PROMOTIONAL_KEY = 'in-app-5usd';

export const SurveyCredits = async (customerInfo: CustomerInfo) => {
  const { user } = customerInfo;
  const posthogClient = PostHogClient();
  const isFlagEnabled = await posthogClient.isFeatureEnabled('show-feedback-form', user.id);

  if (!isFlagEnabled) return null;
  if (!has_used1usd_andHoldOrPayment(customerInfo).success) return null;

  // Check if user has already completed the survey by checking credit_transactions
  const existingSurveyCredit = await db
    .select({ id: credit_transactions.id })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, user.id),
        eq(credit_transactions.credit_category, SURVEY_PROMOTIONAL_KEY)
      )
    )
    .limit(1);

  if (existingSurveyCredit.length > 0) return null; //already completed the survey

  return (
    <div className="flex w-full flex-col items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 p-6 shadow sm:flex-row">
      <div>
        <h4 className="font-medium text-green-800">Get $5 in Free Credits</h4>
        <p className="text-sm text-green-700">Share your feedback in our quick 2-minute survey</p>
      </div>
      <a
        href={`https://form.typeform.com/to/Oe82ZZlK#user_id=${encodeURIComponent(user.id)}&email=${encodeURIComponent(user.google_user_email)}`}
        target="_blank"
        className="ring-offset-background focus-visible:ring-ring inline-flex h-10 items-center justify-center rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        Take Survey
      </a>
    </div>
  );
};
