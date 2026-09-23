import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  assertAppStoreAccountTokenMatchesUser,
  assertGooglePlayAccountTokenMatchesUser,
} from '@/lib/credits/store-account-token';
import { completeStoreCreditPurchase } from '@/lib/credits/store-completion';
import { STORE_CREDIT_PRODUCTS } from '@/lib/credits/store-products';
import {
  acknowledgeGooglePlayCreditPurchase,
  verifyAppleCreditPurchase,
  verifyGooglePlayCreditPurchase,
} from '@/lib/credits/store-verifier';

/**
 * One-off credit packs bought with the store's own purchase sheet.
 *
 * The catalog only holds fixed SKUs because the stores cannot sell an arbitrary
 * amount, so the mobile client offers the four preset amounts. The amount is
 * always resolved from the validated purchase, never from a caller argument,
 * and the grant is idempotent on the store transaction id so a retried
 * completion cannot double-credit.
 */

const MobileStoreCreditProductSchema = z.object({
  amountUsd: z.number(),
  appleProductId: z.string(),
  googleProductId: z.string(),
});

const GetMobileStoreProductsOutputSchema = z.object({
  appAccountToken: z.string(),
  products: z.array(MobileStoreCreditProductSchema),
});

const CompleteStoreCreditPurchaseOutputSchema = z.object({
  amountUsd: z.number(),
  alreadyProcessed: z.boolean(),
});

const CompleteAppStorePurchaseInputSchema = z.object({
  signedTransactionJws: z.string().min(1),
});

const CompletePlayPurchaseInputSchema = z.object({
  productId: z.string().min(1),
  purchaseToken: z.string().min(1),
});

const STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE =
  'This purchase is already linked to another Kilo account.';

/**
 * A store transaction that belongs to another account is terminal — retrying
 * cannot succeed. A receipt the store will never let succeed (a revoked or
 * wrong-bundle Apple transaction, a Play purchase that is not in a purchased
 * state, a product that is not a credit pack) is terminal too, and is reported
 * as such so a caller does not replay it forever — this mirrors the Kilo Pass
 * completion routers. Every other failure (a store or API failure, including a
 * consume that did not complete) is retryable: the grant is idempotent, so the
 * client can safely replay the purchase.
 */
function mapCreditCompletionError(
  error: unknown,
  userId: string,
  operation: 'complete-app-store-purchase' | 'complete-play-purchase'
): TRPCError {
  if (error instanceof TRPCError) {
    return error;
  }

  captureException(error, {
    tags: {
      area: 'credits',
      operation,
    },
    extra: {
      kiloUserId: userId,
    },
  });

  const message = error instanceof Error ? error.message : '';
  if (message.includes('already belongs')) {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE,
    });
  }

  const isVerificationFailure =
    message.startsWith('Apple ') ||
    message.startsWith('Google Play ') ||
    message.includes('transaction') ||
    message.includes('product');
  if (isVerificationFailure) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'We could not verify this store purchase. Please try again.',
    });
  }

  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'We could not finish this purchase. Please try again.',
  });
}

export const creditsRouter = createTRPCRouter({
  getMobileStoreProducts: baseProcedure
    .output(GetMobileStoreProductsOutputSchema)
    .query(({ ctx }) => ({
      appAccountToken: ctx.user.app_store_account_token,
      products: STORE_CREDIT_PRODUCTS.map(product => ({
        amountUsd: product.amountUsd,
        appleProductId: product.appleProductId,
        googleProductId: product.googleProductId,
      })),
    })),

  completeAppStorePurchase: baseProcedure
    .input(CompleteAppStorePurchaseInputSchema)
    .output(CompleteStoreCreditPurchaseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const purchase = await verifyAppleCreditPurchase(input.signedTransactionJws);
        assertAppStoreAccountTokenMatchesUser({
          appAccountToken: purchase.appAccountToken,
          userAppStoreAccountToken: ctx.user.app_store_account_token,
          code: 'FORBIDDEN',
        });
        const result = await completeStoreCreditPurchase({ user: ctx.user, purchase });
        return { amountUsd: result.amountUsd, alreadyProcessed: result.alreadyProcessed };
      } catch (error) {
        throw mapCreditCompletionError(error, ctx.user.id, 'complete-app-store-purchase');
      }
    }),

  completePlayPurchase: baseProcedure
    .input(CompletePlayPurchaseInputSchema)
    .output(CompleteStoreCreditPurchaseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const purchase = await verifyGooglePlayCreditPurchase({
          productId: input.productId,
          purchaseToken: input.purchaseToken,
        });
        assertGooglePlayAccountTokenMatchesUser({
          appAccountToken: purchase.appAccountToken,
          userAppStoreAccountToken: ctx.user.app_store_account_token,
          code: 'FORBIDDEN',
        });
        const result = await completeStoreCreditPurchase({ user: ctx.user, purchase });
        // Consume only after the credit is granted: a one-time Play product must
        // be consumed to be purchasable again, and an interrupted flow can be
        // retried with the same token because the grant is idempotent. A consume
        // failure is retryable, and the paid purchase is never lost.
        await acknowledgeGooglePlayCreditPurchase(input.productId, input.purchaseToken);
        return { amountUsd: result.amountUsd, alreadyProcessed: result.alreadyProcessed };
      } catch (error) {
        throw mapCreditCompletionError(error, ctx.user.id, 'complete-play-purchase');
      }
    }),
});
