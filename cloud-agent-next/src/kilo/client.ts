import type { ExecutionSession } from '../types.js';
import { logger } from '../logger.js';
import {
  KiloClientError,
  KiloApiError,
  KiloTimeoutError,
  KiloSessionNotSetError,
  KiloSessionNotFoundError,
  KiloServerNotReadyError,
} from './errors.js';
import type {
  Session,
  SessionCommandResponse,
  TextPartInput,
  FilePartInput,
  KiloClientOptions,
  HealthResponse,
  CreateSessionOptions,
  PromptOptions,
  CommandOptions,
  SummarizeOptions,
  PermissionResponse,
} from './types.js';

type PromptPart = TextPartInput | FilePartInput;

/** Timeout for health checks during waitForReady polling (seconds). */
const HEALTH_POLL_TIMEOUT_SECONDS = 2;

export class KiloClient {
  private readonly execSession: ExecutionSession;
  private readonly port: number;
  private readonly timeoutSeconds: number;
  private kiloSessionId: string | null = null;

  constructor(options: KiloClientOptions) {
    this.execSession = options.session;
    this.port = options.port;
    this.timeoutSeconds = options.timeoutSeconds ?? 10;
  }

  get currentSessionId(): string | null {
    return this.kiloSessionId;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async health(): Promise<HealthResponse> {
    return this.call<HealthResponse>('GET', '/global/health');
  }

  async waitForReady(timeoutMs: number = 30_000): Promise<HealthResponse> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      try {
        return await this.call<HealthResponse>(
          'GET',
          '/global/health',
          undefined,
          HEALTH_POLL_TIMEOUT_SECONDS
        );
      } catch {
        const elapsed = Date.now() - startTime;
        if (elapsed + pollInterval >= timeoutMs) {
          break;
        }
        await this.sleep(pollInterval);
      }
    }

    throw new KiloServerNotReadyError(`Server not ready after ${timeoutMs}ms on port ${this.port}`);
  }

  async createSession(options?: CreateSessionOptions): Promise<Session> {
    const session = await this.call<Session>('POST', '/session', {
      parentID: options?.parentId,
      title: options?.title,
    });
    this.kiloSessionId = session.id;
    logger.withFields({ kiloSessionId: session.id }).info('Created kilo session');
    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    try {
      const session = await this.call<Session>('GET', `/session/${sessionId}`);
      this.kiloSessionId = session.id;
      logger.withFields({ kiloSessionId: session.id }).info('Resumed kilo session');
      return session;
    } catch (error) {
      if (error instanceof KiloApiError && error.statusCode === 404) {
        throw new KiloSessionNotFoundError(sessionId);
      }
      throw error;
    }
  }

  async importSession(shareUrl: string): Promise<Session> {
    const urlMatch = shareUrl.match(/https?:\/\/kilosessions\.ai\/share\/([a-zA-Z0-9_-]+)/);
    if (!urlMatch) {
      throw new KiloClientError(
        'Invalid share URL format. Expected: https://kilosessions.ai/share/<slug>'
      );
    }

    logger.withFields({ shareUrl }).info('Importing kilo session from URL');

    const result = await this.execSession.exec(`kilo import "${shareUrl}"`, {
      timeout: this.timeoutSeconds * 1000,
    });

    if (result.exitCode !== 0) {
      throw new KiloClientError(`Failed to import session: ${result.stderr || result.stdout}`);
    }

    const match = result.stdout.match(/Imported session:\s*(\S+)/);
    if (!match || !match[1]) {
      throw new KiloClientError(`Failed to parse session ID from import output: ${result.stdout}`);
    }

    const sessionId = match[1];
    logger.withFields({ kiloSessionId: sessionId, shareUrl }).info('Imported kilo session');
    return this.resumeSession(sessionId);
  }

  async promptAsync(parts: PromptPart[], options?: PromptOptions): Promise<void>;
  async promptAsync(text: string, options?: PromptOptions): Promise<void>;
  async promptAsync(partsOrText: PromptPart[] | string, options?: PromptOptions): Promise<void> {
    const sessionId = this.requireSession();
    if (options?.messageId) {
      this.validateMessageId(options.messageId);
    }

    const parts: PromptPart[] =
      typeof partsOrText === 'string' ? [{ type: 'text', text: partsOrText }] : partsOrText;

    await this.call<void>('POST', `/session/${sessionId}/prompt_async`, {
      parts,
      messageID: options?.messageId,
      model: options?.model
        ? {
            providerID: options.model.providerID ?? 'kilo',
            modelID: options.model.modelID,
          }
        : undefined,
      agent: options?.agent,
      noReply: options?.noReply,
      system: options?.system,
      tools: options?.tools,
    });
  }

  async command(
    command: string,
    args?: string,
    options?: CommandOptions
  ): Promise<SessionCommandResponse> {
    const sessionId = this.requireSession();
    if (options?.messageId) {
      this.validateMessageId(options.messageId);
    }

    return this.call<SessionCommandResponse>('POST', `/session/${sessionId}/command`, {
      command,
      arguments: args ?? '',
      messageID: options?.messageId,
      agent: options?.agent,
      model: options?.model,
    });
  }

  /**
   * Respond to a permission request.
   * Uses the new /permission/:requestID/reply endpoint (not the deprecated session endpoint).
   */
  async respondToPermission(
    permissionId: string,
    response: PermissionResponse,
    message?: string
  ): Promise<boolean> {
    return this.call<boolean>('POST', `/permission/${permissionId}/reply`, {
      reply: response,
      message,
    });
  }

  /**
   * Answer a question request from the AI assistant.
   * @param questionId - The question request ID
   * @param answers - Array of answers, one per question. Each answer is an array of selected option labels.
   */
  async answerQuestion(questionId: string, answers: string[][]): Promise<boolean> {
    return this.call<boolean>('POST', `/question/${questionId}/reply`, {
      answers,
    });
  }

  /**
   * Reject/dismiss a question request from the AI assistant.
   * @param questionId - The question request ID
   */
  async rejectQuestion(questionId: string): Promise<boolean> {
    return this.call<boolean>('POST', `/question/${questionId}/reject`);
  }

  async summarize(options: SummarizeOptions): Promise<boolean> {
    const sessionId = this.requireSession();

    return this.call<boolean>('POST', `/session/${sessionId}/summarize`, {
      providerID: options.providerID ?? 'kilo',
      modelID: options.modelID,
    });
  }

  async abort(): Promise<boolean> {
    const sessionId = this.requireSession();
    return this.call<boolean>('POST', `/session/${sessionId}/abort`);
  }

  async call<T>(method: string, path: string, body?: unknown, timeoutSeconds?: number): Promise<T> {
    const timeout = timeoutSeconds ?? this.timeoutSeconds;
    const url = `${this.baseUrl}${path}`;

    const curlArgs = [
      'curl',
      '-s',
      '-S',
      '--fail-with-body',
      '--max-time',
      String(timeout),
      '-w',
      '"\\n%{http_code}"',
      '-X',
      method,
    ];

    let tempFile: string | null = null;

    if (body !== undefined) {
      const json = JSON.stringify(body);
      tempFile = `/tmp/kilo-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

      await this.execSession.writeFile(tempFile, json);

      curlArgs.push('-H', 'Content-Type: application/json');
      curlArgs.push('--data-binary', `@${tempFile}`);
    }

    const quotedUrl = `'${url.replace(/'/g, "'\\''")}'`;
    curlArgs.push(quotedUrl);

    const command = curlArgs.join(' ');

    logger.withFields({ method, path }).debug('KiloClient request');

    try {
      const result = await this.execSession.exec(command, {
        timeout: (timeout + 1) * 1000,
      });

      const { responseBody, httpStatus } = this.parseResponse(result.stdout);

      if (result.exitCode !== 0) {
        throw this.parseExecError(result, method, path, timeout, httpStatus, responseBody);
      }

      if (!responseBody.trim()) {
        return undefined as T;
      }

      try {
        return JSON.parse(responseBody) as T;
      } catch {
        throw new KiloClientError(`Failed to parse response JSON: ${responseBody.slice(0, 200)}`);
      }
    } finally {
      if (tempFile) {
        await this.execSession.deleteFile(tempFile).catch(() => {});
      }
    }
  }

  private parseResponse(stdout: string): { responseBody: string; httpStatus: number } {
    const lastNewline = stdout.lastIndexOf('\n');
    if (lastNewline === -1) {
      return { responseBody: stdout, httpStatus: 0 };
    }

    const statusStr = stdout.slice(lastNewline + 1).trim();
    const httpStatus = parseInt(statusStr, 10) || 0;
    const responseBody = stdout.slice(0, lastNewline);

    return { responseBody, httpStatus };
  }

  private requireSession(): string {
    if (!this.kiloSessionId) {
      throw new KiloSessionNotSetError();
    }
    return this.kiloSessionId;
  }

  private parseExecError(
    result: { exitCode: number; stdout: string; stderr: string },
    method: string,
    path: string,
    timeoutSeconds: number,
    httpStatus: number,
    responseBody: string
  ): KiloClientError {
    const { exitCode, stderr } = result;

    if (exitCode === 28) {
      return new KiloTimeoutError(`Request timed out: ${method} ${path}`, timeoutSeconds * 1000);
    }

    if (exitCode === 22) {
      let errorMessage = `HTTP ${httpStatus}: ${method} ${path}`;

      try {
        const errorBody = JSON.parse(responseBody);
        if (errorBody.message) {
          errorMessage = `${errorMessage} - ${errorBody.message}`;
        }
      } catch {
        if (responseBody && responseBody.length < 200) {
          errorMessage = `${errorMessage} - ${responseBody}`;
        }
      }

      return new KiloApiError(errorMessage, httpStatus, responseBody);
    }

    if (exitCode === 7) {
      return new KiloServerNotReadyError(
        `Connection refused: ${method} ${path} - is the server running on port ${this.port}?`
      );
    }

    return new KiloClientError(
      `curl failed (exit ${exitCode}): ${method} ${path} - ${stderr || responseBody}`
    );
  }

  private validateMessageId(messageId: string): void {
    if (!messageId.startsWith('msg')) {
      throw new KiloClientError(
        `Invalid messageId: "${messageId}". Must start with "msg" prefix (e.g., "msg_my-custom-id")`
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
