import { randomUUID } from 'crypto';
import type { payment_methods } from '@kilocode/db/schema';

export const createTestPaymentMethod = (userId: string): typeof payment_methods.$inferInsert => ({
  id: randomUUID(),
  user_id: userId,
  stripe_id: `pm_test_${randomUUID()}`,
  last4: '4242',
  brand: 'visa',
  type: 'card',
  eligible_for_free_credits: true,
  stripe_fingerprint: `fingerprint_${randomUUID()}`,
  three_d_secure_supported: true,
  stripe_data: {},
  funding: 'credit',
  regulated_status: 'unregulated',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null,
});
