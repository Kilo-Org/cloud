import { Hono } from 'hono';
import { except } from 'hono/combine';
import {
  CUSTOM_ROUTER_DECIDE_PATH,
  CUSTOM_ROUTER_EVAL_CASE_PATH,
  CUSTOM_ROUTER_EVAL_PLAN_PATH,
  CUSTOM_ROUTER_EVAL_RESULT_PATH,
  OWNER_POOL_CONVERSION_SCAN_PATH,
} from '@kilocode/auto-routing-contracts';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { authMiddleware } from './auth';
import { classifierAnalyticsHandler } from './admin-classifier-analytics';
import { getClassifierModelHandler, putClassifierModelHandler } from './admin-classifier-model';
import { getRoutingModeHandler, putRoutingModeHandler } from './admin-routing-mode';
import { getRoutingSettingsHandler, putRoutingSettingsHandler } from './admin-routing-settings';
import { decideHandler } from './decide';
import type { HonoEnv } from './hono-env';
import { ownerPoolConversionScanHandler } from './owner-pool-conversion';
import {
  evalCaseHandler,
  evalPlanHandler,
  evalResultHandler,
  publicDecideHandler,
} from './public-routes';

export { AutoRoutingDecisionCacheDO } from './decision-cache';
export { AutoRoutingModeConfigDO } from './routing-mode';

export const app = new Hono<HonoEnv>();

// User-authenticated routes verify the caller's Kilo token; every other route is internal.
app.use(
  '*',
  except(
    [
      CUSTOM_ROUTER_DECIDE_PATH,
      CUSTOM_ROUTER_EVAL_PLAN_PATH,
      CUSTOM_ROUTER_EVAL_CASE_PATH,
      CUSTOM_ROUTER_EVAL_RESULT_PATH,
    ],
    authMiddleware
  )
);

app.get('/health', c => c.json({ status: 'ok', service: 'auto-routing' }));

app.get('/admin/classifier-model', getClassifierModelHandler);
app.put('/admin/classifier-model', putClassifierModelHandler);
app.get('/admin/routing-mode', getRoutingModeHandler);
app.put('/admin/routing-mode', putRoutingModeHandler);
app.get('/admin/routing-settings', getRoutingSettingsHandler);
app.put('/admin/routing-settings', putRoutingSettingsHandler);
app.get('/admin/classifier-analytics', classifierAnalyticsHandler);
app.post(OWNER_POOL_CONVERSION_SCAN_PATH, ownerPoolConversionScanHandler);

app.post('/decide', decideHandler);

app.post(CUSTOM_ROUTER_DECIDE_PATH, publicDecideHandler);
app.post(CUSTOM_ROUTER_EVAL_PLAN_PATH, evalPlanHandler);
app.post(CUSTOM_ROUTER_EVAL_CASE_PATH, evalCaseHandler);
app.post(CUSTOM_ROUTER_EVAL_RESULT_PATH, evalResultHandler);

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler());

export default app;
