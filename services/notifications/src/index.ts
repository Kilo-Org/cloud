import { Hono } from 'hono';

import { queue } from './queue-consumer';
import { webhooks } from './routes/webhooks';

export { NotificationChannelDO } from './dos/NotificationChannelDO';

const app = new Hono<{ Bindings: Env }>();

app.route('/webhooks', webhooks);

app.get('/', c => c.json({ ok: true }));

export default { fetch: app.fetch, queue };
