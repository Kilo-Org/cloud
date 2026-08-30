import { z } from 'zod';
import { ErrorSchema, type Message, type ToolOutcome } from '@kilocode/agent-harness/contracts';
import {
  ToolRequestSchema,
  toolDefinitions,
  type ToolRequest,
} from '@kilocode/agent-harness/tools';
import { bytes, ReservationSchema, type Reservation, type RunLimits } from '../limits';

const Reply = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('succeeded'),
    body: z.unknown(),
    costMicrodollars: z.int().nonnegative().nullable(),
  }),
  z.object({
    status: z.literal('failed'),
    error: ErrorSchema,
    costMicrodollars: z.int().nonnegative().nullable(),
  }),
]);
const Sources = z.object({
  results: z.array(
    z.object({
      url: z.url({ protocol: /^https?$/ }),
      title: z.string().nullish(),
      text: z.string().optional(),
      publishedDate: z.string().optional(),
    })
  ),
  statuses: z
    .array(
      z.object({
        status: z.enum(['success', 'error']),
        error: z.object({ httpStatusCode: z.int().nullish() }).nullish(),
      })
    )
    .optional(),
});
export type WebResult = {
  outcome: ToolOutcome;
  citations: Message['parts'];
  costMicrodollars: number | null;
};

/** The scheduler must supply its committed reservation. Never release it after an uncertain provider call. */
export async function executeWeb(
  input: unknown,
  budget: { reservation: Reservation; limits: RunLimits; signal: AbortSignal },
  invoke: (request: ToolRequest, httpResponseBytes: number, signal: AbortSignal) => Promise<unknown>
): Promise<WebResult> {
  let costMicrodollars: number | null = null;
  const failed = (
    code: z.infer<typeof ErrorSchema>['code'],
    message: string,
    retryable = false
  ): WebResult => ({
    outcome: { status: 'failed', error: { code, message, retryable } },
    citations: [],
    costMicrodollars,
  });
  const request = ToolRequestSchema.safeParse(input);
  if (
    !request.success ||
    (request.data.name !== 'web.search' && request.data.name !== 'web.retrieve')
  )
    return failed('invalid_input', 'Invalid web request.');
  const { reservation, limits, signal } = budget;
  if (
    !ReservationSchema.safeParse(reservation).success ||
    reservation.kind !== 'tool' ||
    !reservation.webRequest ||
    reservation.status !== 'reserved' ||
    !reservation.toolCallId ||
    reservation.deadline <= Date.now()
  )
    return failed('limit_exceeded', 'A current web request reservation is required.');
  if (bytes(request.data.arguments) > limits.toolInputBytes)
    return failed('limit_exceeded', 'The web request is too large.');
  let raw: unknown;
  try {
    signal.throwIfAborted();
    raw = await invoke(request.data, limits.httpResponseBytes, signal);
  } catch {
    return failed(
      signal.aborted ? 'cancelled' : 'unavailable_tool',
      'The web response was not received; its cost is unknown.',
      !signal.aborted
    );
  }
  try {
    const reply = Reply.parse(raw);
    costMicrodollars = reply.costMicrodollars;
    if (reply.status === 'failed') {
      const result = failed(reply.error.code, reply.error.message, reply.error.retryable);
      return bytes(result) > limits.toolOutputBytes
        ? failed('limit_exceeded', 'The web provider error is too large.')
        : result;
    }
    const response = Sources.parse(reply.body);
    const error = response.statuses?.find(item => item.status === 'error');
    if (error) {
      const status = error.error?.httpStatusCode;
      return failed(
        'unavailable_tool',
        'The provider could not retrieve the page.',
        status == null || status >= 500 || status === 408 || status === 429
      );
    }
    const searching = request.data.name === 'web.search';
    const count =
      request.data.name === 'web.search'
        ? Math.min(request.data.arguments.limit, limits.searchResults)
        : 1;
    const pages = response.results.slice(0, count).map(source => {
      const url = new URL(source.url);
      if (url.username || url.password) throw new Error('Invalid source URL');
      const text = source.text ?? '';
      return {
        url: url.href,
        title: source.title?.trim() || url.href,
        text: searching
          ? Array.from(text).slice(0, limits.snippetCharacters).join('')
          : new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, limits.pageBytes), {
              stream: true,
            }),
        ...(source.publishedDate
          ? { publishedAt: new Date(source.publishedDate).toISOString() }
          : {}),
        untrusted: true as const,
      };
    });
    const definition = toolDefinitions.find(tool => tool.name === request.data.name);
    if (!definition) return failed('invalid_input', 'Invalid web request.');
    const output = definition.outputSchema.parse(
      request.data.name === 'web.search'
        ? pages
        : (pages[0] ?? {
            url: request.data.arguments.url,
            title: request.data.arguments.url,
            text: '',
            untrusted: true,
          })
    );
    const citations: Message['parts'] = pages
      .filter(page => page.text.trim())
      .map(page => ({ type: 'citation', url: page.url, title: page.title }));
    const result: WebResult = {
      outcome: { status: 'succeeded', output },
      citations,
      costMicrodollars,
    };
    if (bytes(result) > limits.toolOutputBytes)
      return failed('limit_exceeded', 'The normalized web output is too large.');
    return result;
  } catch {
    return failed('invalid_output', 'The web provider returned invalid source data.');
  }
}
