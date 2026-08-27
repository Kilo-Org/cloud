import type { WrapperTransport } from '../../kilo/wrapper-client.js';
import type { VercelSandboxRestClient } from './vercel-sandbox-rest-client.js';

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const STATUS_LIMIT_BYTES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const SESSION_READY_TIMEOUT_MS = 120_000;
const SAFE_RANDOM_ID = /^[A-Za-z0-9_-]+$/;
const WRAPPER_HTTP_SCRIPT = `
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const method = process.env.KILO_WRAPPER_METHOD;
const url = process.env.KILO_WRAPPER_URL;
const responsePath = process.env.KILO_WRAPPER_RESPONSE;
const statusPath = process.env.KILO_WRAPPER_STATUS;
const requestPath = process.env.KILO_WRAPPER_REQUEST;
if (!method || !url || !responsePath || !statusPath) process.exit(2);
await mkdir(dirname(responsePath), { recursive: true });
const init = { method, headers: { "Content-Type": "application/json" } };
if (requestPath) init.body = await Bun.file(requestPath).arrayBuffer();
const res = await fetch(url, init);
await Bun.write(responsePath, await res.arrayBuffer());
await Bun.write(statusPath, String(res.status));
`.trim();

export type VercelWrapperTransportOptions = {
  restClient: VercelSandboxRestClient;
  sessionId: string;
  port: number;
  randomId?: () => string;
};

function defaultRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export class VercelWrapperTransport implements WrapperTransport {
  private readonly restClient: VercelSandboxRestClient;
  private readonly sessionId: string;
  private readonly port: number;
  private readonly randomId: () => string;

  constructor(options: VercelWrapperTransportOptions) {
    this.restClient = options.restClient;
    this.sessionId = options.sessionId;
    this.port = options.port;
    this.randomId = options.randomId ?? defaultRandomId;
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const randomId = this.randomId();
    if (!SAFE_RANDOM_ID.test(randomId)) throw new Error('Invalid wrapper transport request ID');
    const directory = `/tmp/kilo-wrapper-${randomId}`;
    const requestPath = `${directory}/request.json`;
    const responsePath = `${directory}/response.json`;
    const statusPath = `${directory}/status.txt`;
    let response: Response | undefined;
    let requestError: unknown;

    try {
      if (body !== undefined) {
        await this.restClient.writeFiles(this.sessionId, '/tmp', [
          {
            path: `kilo-wrapper-${randomId}/request.json`,
            content: JSON.stringify(body),
          },
        ]);
      }

      const result = await this.restClient.executeCommand(this.sessionId, {
        command: 'bun',
        args: ['-e', WRAPPER_HTTP_SCRIPT],
        cwd: '/tmp',
        env: {
          KILO_WRAPPER_METHOD: method,
          KILO_WRAPPER_URL: `http://127.0.0.1:${this.port}${path}`,
          KILO_WRAPPER_RESPONSE: responsePath,
          KILO_WRAPPER_STATUS: statusPath,
          ...(body !== undefined ? { KILO_WRAPPER_REQUEST: requestPath } : {}),
        },
        sudo: false,
        timeoutMs: path === '/session/ready' ? SESSION_READY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
        wait: true,
      });
      if (result.finished.exitCode !== 0) throw new Error('Vercel wrapper request failed');

      const [responseBytes, statusBytes] = await Promise.all([
        this.restClient.readFile(this.sessionId, responsePath, RESPONSE_LIMIT_BYTES),
        this.restClient.readFile(this.sessionId, statusPath, STATUS_LIMIT_BYTES),
      ]);
      const status = Number(new TextDecoder().decode(statusBytes));
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error('Vercel wrapper returned an invalid HTTP status');
      }
      response = new Response(responseBytes, {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      requestError = error;
    }

    try {
      await this.cleanup(directory);
    } catch {
      if (requestError === undefined) throw new Error('Vercel wrapper request cleanup failed');
    }
    if (requestError !== undefined) throw requestError;
    if (!response) throw new Error('Vercel wrapper request produced no response');
    return response;
  }

  private async cleanup(directory: string): Promise<void> {
    const result = await this.restClient.executeCommand(this.sessionId, {
      command: 'rm',
      args: ['-rf', '--', directory],
      cwd: '/tmp',
      env: {},
      sudo: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      wait: true,
    });
    if (result.finished.exitCode !== 0) {
      throw new Error('Vercel wrapper request cleanup failed');
    }
  }
}
