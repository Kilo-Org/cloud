import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { isRecord } from '../../http-contract.js';
import {
  openSelectedRootLiveInteraction,
  readInteractionRequestBody,
} from '../../live-interaction.js';

export type QuestionOption = Record<string, unknown> & {
  label: string;
  description: string;
  labelKey?: string;
  descriptionKey?: string;
  mode?: string;
};

export type QuestionInfo = Record<string, unknown> & {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  questionKey?: string;
  headerKey?: string;
  custom?: boolean;
};

export type QuestionRequest = Record<string, unknown> & {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  blocking?: boolean;
  tool?: { messageID: string; callID: string };
};

export type QuestionRoute =
  | { kind: 'list' }
  | { kind: 'reply'; requestID: string }
  | { kind: 'reject'; requestID: string };

export function parseQuestionRoute(method: string, kiloPath: string): QuestionRoute | null {
  if (method === 'GET' && kiloPath === '/question') return { kind: 'list' };
  const match = /^\/question\/([^/]+)\/(reply|reject)$/.exec(kiloPath);
  if (!match?.[1] || !match[2] || method !== 'POST') return null;
  let requestID: string;
  try {
    requestID = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!requestID) return null;
  return match[2] === 'reply' ? { kind: 'reply', requestID } : { kind: 'reject', requestID };
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isQuestionOption(value: unknown): value is QuestionOption {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    typeof value.description === 'string' &&
    isOptionalString(value.labelKey) &&
    isOptionalString(value.descriptionKey) &&
    isOptionalString(value.mode)
  );
}

function isQuestionInfo(value: unknown): value is QuestionInfo {
  return (
    isRecord(value) &&
    typeof value.question === 'string' &&
    typeof value.header === 'string' &&
    Array.isArray(value.options) &&
    value.options.every(isQuestionOption) &&
    isOptionalBoolean(value.multiple) &&
    isOptionalString(value.questionKey) &&
    isOptionalString(value.headerKey) &&
    isOptionalBoolean(value.custom)
  );
}

function isQuestionTool(value: unknown): value is QuestionRequest['tool'] {
  return isRecord(value) && typeof value.messageID === 'string' && typeof value.callID === 'string';
}

export function isQuestionRequest(value: unknown): value is QuestionRequest {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.startsWith('que') &&
    typeof value.sessionID === 'string' &&
    Array.isArray(value.questions) &&
    value.questions.every(isQuestionInfo) &&
    isOptionalBoolean(value.blocking) &&
    (value.tool === undefined || isQuestionTool(value.tool))
  );
}

function isQuestionReplyBody(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.answers) &&
    value.answers.every(
      answer => Array.isArray(answer) && answer.every(item => typeof item === 'string')
    )
  );
}

export async function handleQuestion(
  context: KiloFacadeHandlerContext,
  route = parseQuestionRoute(context.request.method, context.kiloPath)
): Promise<Response> {
  if (!route) throw new Error('Question handler called for unsupported route');
  let body: Uint8Array | undefined;
  if (route.kind === 'reply') {
    const parsedBody = await readInteractionRequestBody(context.request, isQuestionReplyBody);
    if (parsedBody instanceof Response) return parsedBody;
    body = parsedBody;
  }

  const interaction = await openSelectedRootLiveInteraction(context);
  if (interaction instanceof Response) return interaction;

  if (route.kind === 'list') {
    const questions = await interaction.list({ path: '/question', isEntry: isQuestionRequest });
    return questions instanceof Response ? questions : Response.json(questions);
  }

  if (route.kind === 'reply') {
    return interaction.mutate({
      listPath: '/question',
      mutationPath: `/question/${encodeURIComponent(route.requestID)}/reply`,
      requestID: route.requestID,
      isEntry: isQuestionRequest,
      body,
    });
  }

  return interaction.mutate({
    listPath: '/question',
    mutationPath: `/question/${encodeURIComponent(route.requestID)}/reject`,
    requestID: route.requestID,
    isEntry: isQuestionRequest,
  });
}
