// Dumps the current accessibility hierarchy (XML page source) for a device.
// Inspect before selecting; re-inspect after UI changes. Output is large by
// nature — redirect to a file and grep it, never print it wholesale into a
// session transcript.
const { connect } = require('./client');

async function main() {
  const device = process.env.DEVICE;
  if (!device) {
    console.error('usage: DEVICE=<udid> node hierarchy.js');
    process.exit(1);
  }
  const driver = await connect(device);
  try {
    process.stdout.write(await driver.getPageSource());
    process.stdout.write('\n');
  } finally {
    await driver.deleteSession().catch(() => {});
  }
}

main().catch(err => {
  console.error(`hierarchy failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
