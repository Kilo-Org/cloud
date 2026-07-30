// Runs one flow module against a device. Exit code is the verdict: 0 when the
// flow completes, 1 on any assertion, selector, or driver error — no report
// files to second-guess.
//
//   DEVICE=<udid> node run-flow.js <flow-file.js>
//
// Flow modules export an async function receiving
//   { driver, h, env, device, platform, when, whenNot }
// where `h` holds the selector helpers (see helpers.js) and `env` carries
// flow parameters such as EMAIL and OTP.
const path = require('node:path');
const { connect, platformFor } = require('./client');
const helpers = require('./helpers');

async function main() {
  const flowPath = process.argv[2];
  const device = process.env.DEVICE;
  if (!flowPath || !device) {
    console.error('usage: DEVICE=<udid> node run-flow.js <flow-file.js>');
    process.exit(1);
  }
  const flow = require(path.resolve(flowPath));
  const platform = platformFor(device);
  const driver = await connect(device);
  try {
    const h = helpers.make(driver, platform);
    await flow({
      device,
      driver,
      env: process.env,
      h,
      platform,
      when: helpers.when,
      whenNot: helpers.whenNot,
    });
    console.log(`FLOW OK ${path.basename(flowPath)} (${platform} ${device})`);
  } finally {
    await driver.deleteSession().catch(() => {});
  }
}

main().catch(err => {
  const message = err && err.message ? err.message.split('\n')[0] : String(err);
  console.error(`FLOW FAILED ${process.argv[2] || ''}: ${message}`);
  process.exit(1);
});
