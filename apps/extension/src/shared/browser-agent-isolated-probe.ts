import { z } from 'zod';
import { originPatternMatches, toBrowserOrigin } from './browser-agent-checks';
import { maskScreenshotDataUrl } from './browser-screenshot-masking';
import type { ScreenshotBox } from './browser-screenshot-masking';
import type { EvalTabResult } from './tab-debugger';

/**
 * The agent gate's page reads on a browser without a debugger protocol
 * (Firefox): the frame list, the sensitive-field checks and the screenshot
 * mask geometry, each answered by `runIsolatedAgentProbe`
 * (`browser-agent-isolated-probe-script.ts`) in the tab's content-script world.
 */

/** What one probe run asks the page; `selector` names a `target` probe's element. */
export interface IsolatedProbeRequest {
  readonly kind: 'boxes' | 'focused' | 'frame' | 'presence' | 'target';
  readonly selector?: string;
}

/** One injection's answer: the frame it ran in and the probe's JSON text. */
export interface IsolatedProbeResult {
  readonly frameId: number;
  readonly result: unknown;
}

/** Runs one probe request in every frame of the tab, or in the listed frames only. */
export type IsolatedAgentProbe = (
  request: IsolatedProbeRequest,
  frameIds?: readonly number[]
) => Promise<readonly IsolatedProbeResult[]>;

/** The frame shape `browser-agent-frames.ts` keys every scoping decision on. */
export interface IsolatedAgentFrame {
  readonly id: string;
  readonly origin: string;
  readonly parentId?: string;
  readonly url: string;
}

/** The sensitive-target classification the debugger probe answers too, read by `browser-agent-probes.ts`. */
export interface IsolatedTargetProbe {
  readonly fields: readonly { readonly kind: string }[];
  readonly paymentFormSubmit: boolean;
}

const MAIN_FRAME_ID = 0;

const probeTextSchema = z.string();
const framePayloadSchema = z.object({
  origin: z.string(),
  parentFrameId: z.number().nullable(),
  url: z.string(),
});
const targetProbeSchema = z.object({
  fields: z.array(z.object({ kind: z.string() })),
  paymentFormSubmit: z.boolean(),
});
const targetPayloadSchema = z.object({ probe: targetProbeSchema.optional() });
const focusedPayloadSchema = z.object({
  frameId: z.number().nullable().optional(),
  probe: targetProbeSchema.optional(),
});
const presencePayloadSchema = z.object({ closed: z.boolean(), present: z.boolean() });
const boxSchema = z.object({
  height: z.number(),
  left: z.number(),
  top: z.number(),
  width: z.number(),
});
const boxesPayloadSchema = z.object({
  fields: z.array(boxSchema),
  owners: z.array(z.object({ box: boxSchema, frameId: z.number().nullable() })),
});
const capturedScreenshotSchema = z.object({ dataUrl: z.string() }).loose();

const parsePayload = <Payload>(value: unknown, schema: z.ZodType<Payload>): Payload | undefined => {
  const text = probeTextSchema.safeParse(value);

  if (!text.success) {
    return undefined;
  }

  try {
    const parsed = schema.safeParse(JSON.parse(text.data));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const runProbe = async (
  probe: IsolatedAgentProbe,
  request: IsolatedProbeRequest,
  frameIds?: readonly number[]
): Promise<readonly IsolatedProbeResult[]> => {
  try {
    return await probe(request, frameIds);
  } catch {
    return [];
  }
};

/**
 * The tab's frames, main frame first, from one injection per frame. A frame
 * the extension cannot inject into is missing from the list, so every decision
 * that needs it fails closed; without the main frame nothing is complete.
 */
export const readIsolatedFrames = async (
  probe: IsolatedAgentProbe
): Promise<{ readonly complete: boolean; readonly frames: readonly IsolatedAgentFrame[] }> => {
  const main: IsolatedAgentFrame[] = [];
  const children: IsolatedAgentFrame[] = [];

  for (const { frameId, result } of await runProbe(probe, { kind: 'frame' })) {
    const payload = parsePayload(result, framePayloadSchema);

    if (payload !== undefined) {
      const declared =
        payload.origin === '' || payload.origin === 'null' ? 'opaque:null' : payload.origin;
      const frame = {
        id: String(frameId),
        origin: toBrowserOrigin(payload.url) ?? declared,
        url: payload.url,
      };

      if (frameId === MAIN_FRAME_ID) {
        main.push(frame);
      } else {
        children.push({ ...frame, parentId: String(payload.parentFrameId ?? MAIN_FRAME_ID) });
      }
    }
  }

  return { complete: main.length > 0, frames: [...main, ...children] };
};

/** The classification of the one element a selector names, or nothing when it names none or several. */
export const readIsolatedTargetProbe = async (
  probe: IsolatedAgentProbe,
  selector: string
): Promise<IsolatedTargetProbe | undefined> => {
  const [answer] = await runProbe(probe, { kind: 'target', selector }, [MAIN_FRAME_ID]);

  return parsePayload(answer?.result, targetPayloadSchema)?.probe;
};

/**
 * What has focus: the classification of a focused element, or the id of a
 * frame the probe cannot look into (a cross-origin document).
 */
export const readIsolatedFocusProbe = async (
  probe: IsolatedAgentProbe
): Promise<{ readonly frameId?: string; readonly probe?: IsolatedTargetProbe } | undefined> => {
  const [answer] = await runProbe(probe, { kind: 'focused' }, [MAIN_FRAME_ID]);
  const payload = parsePayload(answer?.result, focusedPayloadSchema);

  if (payload === undefined) {
    return undefined;
  }

  if (payload.frameId !== undefined) {
    return payload.frameId === null ? {} : { frameId: String(payload.frameId) };
  }

  return payload.probe === undefined ? {} : { probe: payload.probe };
};

/** Whether one frame holds a password, one-time-code or payment field; `unknown` when it cannot be read. */
export const readIsolatedSensitivePresence = async (
  probe: IsolatedAgentProbe,
  frameId: string
): Promise<'absent' | 'present' | 'unknown'> => {
  const [answer] = await runProbe(probe, { kind: 'presence' }, [Number(frameId)]);
  const payload = parsePayload(answer?.result, presencePayloadSchema);

  if (payload === undefined) {
    return 'unknown';
  }

  if (payload.present) {
    return 'present';
  }

  return payload.closed ? 'unknown' : 'absent';
};

const translate = (box: ScreenshotBox, offset: { left: number; top: number }): ScreenshotBox => ({
  height: box.height,
  left: box.left + offset.left,
  top: box.top + offset.top,
  width: box.width,
});

/**
 * The viewport regions an agent's screenshot must black out: every frame
 * element whose document is not readable (or was never seen), and every
 * sensitive field in a readable frame. A readable frame that answered no
 * geometry fails the whole capture closed.
 */
export const readIsolatedScreenshotMask = async (
  probe: IsolatedAgentProbe,
  frames: readonly IsolatedAgentFrame[],
  readableOrigins: readonly string[]
): Promise<{ readonly boxes: readonly ScreenshotBox[] } | { readonly error: string }> => {
  const reports = new Map<string, z.infer<typeof boxesPayloadSchema>>();

  for (const { frameId, result } of await runProbe(probe, { kind: 'boxes' })) {
    const payload = parsePayload(result, boxesPayloadSchema);

    if (payload !== undefined) {
      reports.set(String(frameId), payload);
    }
  }

  const readable = new Set(
    frames
      .filter(
        frame =>
          frame.parentId === undefined ||
          readableOrigins.some(pattern => originPatternMatches(pattern, frame.origin))
      )
      .map(frame => frame.id)
  );
  const boxes: ScreenshotBox[] = [];
  const pending = [{ id: String(MAIN_FRAME_ID), offset: { left: 0, top: 0 } }];

  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const report = reports.get(next.id);

    if (report === undefined) {
      return {
        error:
          'The tab’s frames could not be read, so no screenshot was returned. Try again once the page has loaded.',
      };
    }

    const { offset } = next;

    boxes.push(...report.fields.map(box => translate(box, offset)));

    for (const owner of report.owners) {
      const childId = owner.frameId === null ? undefined : String(owner.frameId);

      if (childId !== undefined && readable.has(childId)) {
        pending.push({
          id: childId,
          offset: { left: offset.left + owner.box.left, top: offset.top + owner.box.top },
        });
      } else {
        boxes.push(translate(owner.box, offset));
      }
    }
  }

  return { boxes };
};

/**
 * An agent's screenshot on the scripting backend, with every region it may not
 * see blacked out. The capture is in CSS pixels (`tabs.captureTab` at scale 1),
 * so the viewport boxes map onto it one to one. Anything that cannot be masked
 * returns no image at all.
 */
export const maskIsolatedAgentScreenshot = async (input: {
  readonly capture: EvalTabResult;
  readonly frames: readonly IsolatedAgentFrame[];
  readonly probe: IsolatedAgentProbe | undefined;
  readonly readableOrigins: readonly string[];
}): Promise<EvalTabResult> => {
  if (!input.capture.ok) {
    return input.capture;
  }

  const captured = capturedScreenshotSchema.safeParse(input.capture.value);

  if (!captured.success || input.probe === undefined) {
    return { error: 'The screenshot could not be masked for this caller.', ok: false };
  }

  const mask = await readIsolatedScreenshotMask(input.probe, input.frames, input.readableOrigins);

  if ('error' in mask) {
    return { error: mask.error, ok: false };
  }

  const masked = await maskScreenshotDataUrl({
    boxes: mask.boxes,
    dataUrl: captured.data.dataUrl,
    mediaType: 'image/png',
    scale: 1,
  });

  return masked.ok
    ? { ok: true, value: { ...captured.data, dataUrl: masked.dataUrl, mediaType: 'image/png' } }
    : { error: masked.error, ok: false };
};
