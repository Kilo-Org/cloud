import 'server-only';

// ---------------------------------------------------------------------------
// AgentCard REST API client for B2B integration
//
// Uses an org-scoped API key (sk_test_* / sk_live_*) to manage cardholders
// and virtual cards on behalf of users.
//
// Integration guide: https://docs.agentcard.sh/integration-guide
// ---------------------------------------------------------------------------

const AGENTCARD_API_KEY = process.env.AGENTCARD_API_KEY ?? '';

/** Resolve base URL from key prefix (sandbox for sk_test_, production for sk_live_). */
function baseUrl(): string {
  if (AGENTCARD_API_KEY.startsWith('sk_test_')) {
    return 'https://sandbox.api.agentcard.sh';
  }
  return 'https://api.agentcard.sh';
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class AgentCardApiError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody = '') {
    super(`AgentCard API error (${statusCode}): ${responseBody}`);
    this.name = 'AgentCardApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Cardholder {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  dateOfBirth: string;
  phoneNumber: string;
  stripeCardholderId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCardholderInput {
  firstName: string;
  lastName: string;
  dateOfBirth: string; // ISO date, e.g. "1990-03-15"
  phoneNumber: string;
  email?: string;
}

export interface PaymentMethodSetupResponse {
  checkoutUrl: string;
  stripeSessionId: string;
}

export interface PaymentMethodStatusResponse {
  hasPaymentMethod: boolean;
  paymentMethodId?: string;
}

export interface Card {
  id: string;
  cardholderId: string;
  last4: string;
  expiry: string;
  spendLimitCents: number;
  balanceCents: number;
  status: 'OPEN' | 'IN_USE' | 'CLOSED' | 'PAUSED';
  createdAt: string;
}

export interface CardDetails extends Card {
  pan: string;
  cvv: string;
}

export interface CardListResponse {
  cards: Card[];
  total: number;
  limit: number;
  offset: number;
}

export interface CardListFilters {
  status?: 'OPEN' | 'IN_USE' | 'CLOSED' | 'PAUSED';
  cardholderId?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!AGENTCARD_API_KEY) {
    throw new Error('AGENTCARD_API_KEY is not configured');
  }

  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${AGENTCARD_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AgentCardApiError(res.status, text);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Cardholder operations
// ---------------------------------------------------------------------------

/** Create a cardholder record for a user. */
export async function createCardholder(
  input: CreateCardholderInput,
): Promise<Cardholder> {
  return request<Cardholder>('POST', '/api/v1/cardholders', input);
}

/** Get a cardholder by ID. */
export async function getCardholder(id: string): Promise<Cardholder> {
  return request<Cardholder>('GET', `/api/v1/cardholders/${id}`);
}

// ---------------------------------------------------------------------------
// Payment method operations
// ---------------------------------------------------------------------------

/**
 * Start payment method setup for a cardholder.
 * Returns a Stripe Checkout URL the user must visit to attach their card.
 */
export async function setupPaymentMethod(
  cardholderId: string,
): Promise<PaymentMethodSetupResponse> {
  return request<PaymentMethodSetupResponse>(
    'POST',
    `/api/v1/cardholders/${cardholderId}/payment-method/setup`,
  );
}

/** Check whether a cardholder has a payment method attached. */
export async function getPaymentMethodStatus(
  cardholderId: string,
): Promise<PaymentMethodStatusResponse> {
  return request<PaymentMethodStatusResponse>(
    'GET',
    `/api/v1/cardholders/${cardholderId}/payment-method/status`,
  );
}

// ---------------------------------------------------------------------------
// Card operations
// ---------------------------------------------------------------------------

/**
 * Issue a single-use virtual Visa card.
 * amountCents is authorized (held) on the cardholder's payment method immediately.
 * Max $50.00 (5000) on free plan, $500.00 (50000) on basic plan.
 */
export async function createCard(
  cardholderId: string,
  amountCents: number,
): Promise<Card> {
  return request<Card>('POST', '/api/v1/cards', {
    cardholderId,
    amountCents,
  });
}

/** List cards with optional filters. */
export async function listCards(
  filters?: CardListFilters,
): Promise<CardListResponse> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.cardholderId) params.set('cardholderId', filters.cardholderId);
  if (filters?.limit) params.set('limit', String(filters.limit));
  if (filters?.offset) params.set('offset', String(filters.offset));

  const qs = params.toString();
  return request<CardListResponse>('GET', `/api/v1/cards${qs ? `?${qs}` : ''}`);
}

/** Get card summary (no credentials). */
export async function getCard(cardId: string): Promise<Card> {
  return request<Card>('GET', `/api/v1/cards/${cardId}`);
}

/**
 * Get full card credentials (PAN, CVV, expiry).
 * All access is logged in the audit trail.
 */
export async function getCardDetails(cardId: string): Promise<CardDetails> {
  return request<CardDetails>('GET', `/api/v1/cards/${cardId}/details`);
}

/**
 * Permanently close a card and release held funds.
 * Idempotent — closing an already-closed card returns success.
 */
export async function closeCard(
  cardId: string,
): Promise<{ id: string; status: 'CLOSED' }> {
  return request<{ id: string; status: 'CLOSED' }>(
    'DELETE',
    `/api/v1/cards/${cardId}`,
  );
}
