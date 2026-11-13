import { PostHog } from 'posthog-js/dist/module.no-external';

const POSTHOG_API_HOST = 'https://us.i.posthog.com';

// Exact MV3-safe init option set from the plan (key order sorted for lint).
const POSTHOG_INIT_OPTIONS = {
  advanced_disable_flags: true,
  api_host: POSTHOG_API_HOST,
  autocapture: false,
  capture_pageleave: false,
  capture_pageview: false,
  disable_external_dependency_loading: true,
  disable_session_recording: true,
  persistence: 'localStorage',
} as const;

/** Build-time project key; without one analytics is compiled out. */
export const readApiKey = (): string | undefined => {
  const key = import.meta.env.VITE_POSTHOG_API_KEY;
  return key !== undefined && key.trim().length > 0 ? key.trim() : undefined;
};

export const createPostHogClient = (apiKey: string): PostHog => {
  const client = new PostHog();
  client.init(apiKey, { ...POSTHOG_INIT_OPTIONS });
  return client;
};
