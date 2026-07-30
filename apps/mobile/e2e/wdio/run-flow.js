// Runs flow modules against a device on one driver session. Exit code is the
// verdict: 0 when every flow completes, 1 on any assertion, selector, or
// driver error — no report files to second-guess. Flows manage app lifecycle
// themselves, so sequential flows on one session behave exactly like
// sequential invocations, minus the session setup each.
//
//   DEVICE=<udid> node run-flow.js <flow-file.js> [more-flows.js]
//
// Flow modules export an async function receiving
//   { driver, h, env, device, platform, when, whenNot }
// where `h` holds the selector helpers (see helpers.js) and `env` carries
// flow parameters such as EMAIL and OTP.
const path = require('node:path');
const { connect, platformFor } = require('./client');
const helpers = require('./helpers');

async function main() {
  const flowPaths = process.argv.slice(2);
  const device = process.env.DEVICE;
  if (flowPaths.length === 0 || !device) {
    console.error('usage: DEVICE=<udid> node run-flow.js <flow-file.js> [more-flows.js]');
    process.exit(1);
  }
  const platform = platformFor(device);
  const driver = await connect(device);
  try {
    const h = helpers.make(driver, platform);
    const ctx = {
      device,
      driver,
      env: process.env,
      h,
      platform,
      when: helpers.when,
      whenNot: helpers.whenNot,
    };
    for (const flowPath of flowPaths) {
      const flow = require(path.resolve(flowPath));
      await flow(ctx);
      console.log(`FLOW OK ${path.basename(flowPath)} (${platform} ${device})`);
    }
  } finally {
    await driver.deleteSession().catch(() => {});
  }
}

main().catch(err => {
  const message = err && err.message ? err.message.split('\n')[0] : String(err);
  console.error(`FLOW FAILED: ${message}`);
  process.exit(1);
});
