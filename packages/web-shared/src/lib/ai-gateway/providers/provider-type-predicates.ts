import { CLAUDE_BILLING_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';
import { OPENAI_CHATGPT_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/provider-id';
import type { ProviderType } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export function isDelegatedBillingProvider(provider: ProviderType): boolean {
  return provider === OPENAI_CHATGPT_PROVIDER_ID || provider === CLAUDE_BILLING_PROVIDER_ID;
}

export function isGatewayBackend(provider: ProviderType): boolean {
  return provider === 'openrouter' || provider === 'vercel';
}

export function isPromotionalModelProvider(provider: ProviderType): boolean {
  return provider === 'custom' || provider === 'custom-public';
}
