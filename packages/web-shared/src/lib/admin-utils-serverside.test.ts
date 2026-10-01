import { db } from '@/lib/drizzle';
import { payment_methods } from '@kilocode/db/schema';
import { hasPaymentMethod } from './admin-utils-serverside';
import { createTestPaymentMethod } from '@/tests/helpers/payment-method.helper';

describe('admin-utils-serverside', () => {
  describe('hasPaymentMethod', () => {
    it('should return true when user has an active payment method', async () => {
      const userId = 'test-user-1';
      const paymentMethod = createTestPaymentMethod(userId);
      await db.insert(payment_methods).values(paymentMethod);

      const result = await hasPaymentMethod(userId);
      expect(result).toBe(true);
    });

    it('should return false when user has no payment method', async () => {
      const result = await hasPaymentMethod('non-existent-user');
      expect(result).toBe(false);
    });

    it('should return false when user only has deleted payment methods', async () => {
      const userId = 'test-user-2';
      const deletedPaymentMethod = {
        ...createTestPaymentMethod(userId),
        deleted_at: new Date().toISOString(),
      };
      await db.insert(payment_methods).values(deletedPaymentMethod);

      const result = await hasPaymentMethod(userId);
      expect(result).toBe(false);
    });

    it('should return true when user has both active and deleted payment methods', async () => {
      const userId = 'test-user-3';
      const activePaymentMethod = createTestPaymentMethod(userId);
      const deletedPaymentMethod = {
        ...createTestPaymentMethod(userId),
        deleted_at: new Date().toISOString(),
      };

      await db.insert(payment_methods).values([activePaymentMethod, deletedPaymentMethod]);

      const result = await hasPaymentMethod(userId);
      expect(result).toBe(true);
    });
  });
});
