/**
 * HTTP client for talking to a kilo serve instance.
 *
 * Modeled after cloud-agent-next/wrapper/src/kilo-client.ts but simplified
 * for the gastown container use-case (no sandbox indirection, direct fetch).
 *
 * All responses are parsed with Zod at the IO boundary — no `as` casts.
 */

import { z } from 'zod';
import { KiloSession, KiloHealthResponse } from './types';

type TextPart = { type: 'text'; text: string };

type SendPromptBody = {
  parts: TextPart[];
  agent?: string;
  model?: { providerID: string; modelID: string };
  system?: string;
  tools?: Record<string, boolean>;
};

export type KiloClient = {
  checkHealth: () => Promise<z.infer<typeof KiloHealthResponse>>;
  createSession: () => Promise<z.infer<typeof KiloSession>>;
  getSession: (sessionId: string) => Promise<z.infer<typeof KiloSession>>;
  sendPromptAsync: (
    sessionId: string,
    opts: {
      prompt: string;
      model?: string;
      systemPrompt?: string;
      agent?: string;
    }
  ) => Promise<void>;
  abortSession: (sessionId: string) => Promise<void>;
};

/**
 * Create a client for interacting with a kilo serve instance on the given port.
 */
export function createKiloClient(port: number): KiloClient {
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`kilo API ${method} ${path}: ${res.status} ${res.statusText} — ${text}`);
    }

    // 204 No Content
    if (res.status === 204) return undefined;

    return res.json();
  }

  return {
    checkHealth: async () => {
      const raw = await request('GET', '/global/health');
      return KiloHealthResponse.parse(raw);
    },

    createSession: async () => {
      const raw = await request('POST', '/session', {});
      return KiloSession.parse(raw);
    },

    getSession: async sessionId => {
      const raw = await request('GET', `/session/${sessionId}`);
      return KiloSession.parse(raw);
    },

    sendPromptAsync: async (sessionId, opts) => {
      const body: SendPromptBody = {
        parts: [{ type: 'text', text: opts.prompt }],
      };

      if (opts.model) {
        body.model = { providerID: 'kilo', modelID: opts.model };
      }
      if (opts.systemPrompt) {
        body.system = opts.systemPrompt;
      }
      if (opts.agent) {
        body.agent = opts.agent;
      }

      await request('POST', `/session/${sessionId}/prompt_async`, body);
    },

    abortSession: async sessionId => {
      await request('POST', `/session/${sessionId}/abort`);
    },
  };
}
