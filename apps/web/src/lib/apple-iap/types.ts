export type AppleIapEnvironment = 'Sandbox' | 'Production';

export type AppleDecodedTransaction = {
  transactionId: string;
  originalTransactionId: string;
  webOrderLineItemId?: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  revocationDate?: number;
  appAccountToken?: string;
  environment: AppleIapEnvironment;
  type?: string;
};

export type AppleDecodedNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  data?: {
    environment?: AppleIapEnvironment;
    signedTransactionInfo?: string;
  };
};
