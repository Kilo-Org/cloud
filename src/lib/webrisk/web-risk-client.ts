import { GOOGLE_WEB_RISK_API_KEY } from '@/lib/config.server';

type ThreatType = 'MALWARE' | 'SOCIAL_ENGINEERING' | 'UNWANTED_SOFTWARE';

type WebRiskResponse = {
  threat?: {
    threatTypes: ThreatType[];
    expireTime: string;
  };
};

type CheckUrlResult = {
  isThreat: boolean;
  threatTypes: ThreatType[];
  expireTime?: string;
};

type WebRiskClient = {
  checkUrl: (url: string) => Promise<CheckUrlResult>;
};

export function createWebRiskClient(): WebRiskClient {
  if (!GOOGLE_WEB_RISK_API_KEY) {
    throw new Error('GOOGLE_WEB_RISK_API_KEY is not configured');
  }

  const apiKey = GOOGLE_WEB_RISK_API_KEY;
  const baseUrl = 'https://webrisk.googleapis.com/v1';

  return {
    async checkUrl(url: string): Promise<CheckUrlResult> {
      const threatTypes = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'];

      const params = new URLSearchParams();
      params.append('key', apiKey);
      params.append('uri', url);
      threatTypes.forEach(t => params.append('threatTypes', t));

      const response = await fetch(`${baseUrl}/uris:search?${params}`);

      if (!response.ok) {
        throw new Error(`Web Risk API error: ${response.status} ${response.statusText}`);
      }

      const data: WebRiskResponse = await response.json();

      return {
        isThreat: !!data.threat,
        threatTypes: data.threat?.threatTypes ?? [],
        expireTime: data.threat?.expireTime,
      };
    },
  };
}

export type { ThreatType, CheckUrlResult };
