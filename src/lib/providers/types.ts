export type ProviderId =
  | 'openrouter'
  | 'alibaba'
  | 'corethink'
  | 'martian'
  | 'mistral'
  | 'morph'
  | 'vercel'
  | 'custom'
  | 'dev-tools';

export type Provider = {
  id: ProviderId;
  apiUrl: string;
  apiKey: string;
};
