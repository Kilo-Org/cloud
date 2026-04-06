/**
 * Mimics the Vercel cron that hits /api/discord/gateway every 9 minutes.
 * The gateway handler runs for 10 minutes, so there's ~1 minute of overlap
 * where the new listener takes over via leader election and the old one
 * shuts down via heartbeat detection.
 *
 * Races the fetch against a 9-minute timer: whichever finishes first triggers
 * the next request. This means if the endpoint returns early (e.g. error),
 * we retry immediately instead of waiting out the full interval.
 *
 * Usage: npx tsx dev/discord-gateway-cron.ts
 */
import '../apps/web/src/lib/load-env';

const CRON_SECRET = process.env.CRON_SECRET;
if (!CRON_SECRET) {
  console.error('Error: CRON_SECRET not found in environment');
  process.exit(1);
}

const GATEWAY_URL = 'http://localhost:3000/api/discord/gateway';
const INTERVAL_MS = 9 * 60 * 1000;

function timestamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function loop() {
  console.log(`Starting discord gateway cron (every ${INTERVAL_MS / 1000}s)`);
  console.log(`URL: ${GATEWAY_URL}`);

  while (true) {
    console.log(`[${timestamp()}] Sending request to gateway...`);

    const fetchDone = fetch(GATEWAY_URL, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    })
      .then(res => console.log(`[${timestamp()}]   -> HTTP ${res.status}`))
      .catch(err => console.error(`[${timestamp()}]   -> Error: ${err.message}`));

    // Race: whichever finishes first triggers the next request.
    // On success this is the 9-minute timer; on early failure it's immediate.
    await Promise.race([fetchDone, sleep(INTERVAL_MS)]);
  }
}

void loop();
