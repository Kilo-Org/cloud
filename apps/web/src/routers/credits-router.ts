import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { sanitizeErrorForTelemetry } from '@/lib/sanitize-error-for-telemetry';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  assertAppStoreAccountTokenMatchesUser,
  assertGooglePlayAccountTokenMatchesUser,
} from '@/lib/credits/store-account-token';
import { completeStoreCreditPurchase } from '@/lib/credits/store-completion';
import {
  StoreCreditPurchaseOwnedByAnotherAccountError,
  StoreVerificationError,
} from '@/lib/credits/store-purchase-errors';
import { STORE_PURCHASE_REFUNDED_MESSAGE } from '@/lib/credits/store-refund';
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
 * consume that did not complete, and any database failure) is retryable: the
 * grant is idempotent, so the client can safely replay the purchase.
 *
 * Terminal versus retryable is decided by the error *type*. Classifying by
 * message text made a transient database error whose SQL happens to name
 * `credit_transactions` look like a refused receipt, and the mobile client
 * records a terminal refusal for the rest of the process: a database blip could
 * strand a purchase the user had already paid for.
 */
function mapCreditCompletionError(
  error: unknown,
  userId: string,
  operation: 'complete-app-store-purchase' | 'complete-play-purchase',
  secrets: readonly string[]
): TRPCError {
  if (error instanceof TRPCError) {
    return error;
  }

  // A purchase the store refunded is an expected outcome, not an incident: the
  // store reversed the charge, so no retry can grant it. It is terminal for the
  // same reason a receipt the store will never let succeed is — the client must
  // stop replaying it instead of retrying forever.
  if (error instanceof Error && error.message === STORE_PURCHASE_REFUNDED_MESSAGE) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: STORE_PURCHASE_REFUNDED_MESSAGE,
    });
  }

  // A store credential is never part of the report: a database or provider
  // error quotes the parameters it was built from, and a Play purchase token is
  // a bearer credential.
  captureException(sanitizeErrorForTelemetry(error, secrets), {
    tags: {
      area: 'credits',
      operation,
    },
    extra: {
      kiloUserId: userId,
    },
  });

  if (error instanceof StoreVerificationError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'We could not verify this store purchase. Please try again.',
    });
  }

  if (error instanceof StoreCreditPurchaseOwnedByAnotherAccountError) {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE,
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
        throw mapCreditCompletionError(error, ctx.user.id, 'complete-app-store-purchase', [
          input.signedTransactionJws,
        ]);
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
        throw mapCreditCompletionError(error, ctx.user.id, 'complete-play-purchase', [
          input.purchaseToken,
        ]);
      }
    }),
});
