import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';
import { TimeseriesWindow } from '../dos/town/metrics';

const ReportUsageBody = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_microdollars: z.number().int().nonnegative(),
});

export async function handleReportUsage(c: Context<GastownEnv>, params: { townId: string }) {
  const parsed = ReportUsageBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(resError('Invalid request body'), 400);
  }
  const town = getTownDOStub(c.env, params.townId);
  await town.reportUsage(
    parsed.data.input_tokens,
    parsed.data.output_tokens,
    parsed.data.cost_microdollars
  );
  return c.json(resSuccess({ ok: true }));
}

const ReportLocBody = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export async function handleReportLoc(c: Context<GastownEnv>, params: { townId: string }) {
  const parsed = ReportLocBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(resError('Invalid request body'), 400);
  }
  const town = getTownDOStub(c.env, params.townId);
  await town.reportLoc(parsed.data.additions, parsed.data.deletions);
  return c.json(resSuccess({ ok: true }));
}

export async function handleGetMetricsTimeseries(
  c: Context<GastownEnv>,
  params: { townId: string }
) {
  const window = c.req.query('window') ?? '1h';
  const parsed = TimeseriesWindow.safeParse(window);
  if (!parsed.success) {
    return c.json(resError('Invalid window parameter. Must be 1h, 6h, 24h, or 7d'), 400);
  }
  const town = getTownDOStub(c.env, params.townId);
  const data = await town.getMetricsTimeseries(parsed.data);
  return c.json(resSuccess(data));
}
