import type { ProviderId } from './provider-id.js';

export type Provider = {
  id: ProviderId;
  apiUrl: string;
  apiKey: string;
  hasGenerationEndpoint: boolean;
};
