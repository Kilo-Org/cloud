import * as z from 'zod';

export const SubscriptionsSeatQuantitySchema = z
  .number()
  .int('Quantity must be a whole number')
  .min(1)
  .max(
    100,
    'If you want to create more than 100 seats please contact our enterprise support team.'
  );
