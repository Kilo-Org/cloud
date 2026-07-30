// Deterministic per-device Appium port assignment. Used by appium.sh (via
// `node ports.js <device>`) and client.js, so both always agree.
//
// One device gets a block of consecutive ports:
//   base+0  appium server
//   base+1  iOS WebDriverAgent (wdaLocalPort)
//   base+2  Android UiAutomator2 systemPort
// Base ranges 4730-9726 in steps of 10, hashed from the device id, so
// parallel worktrees/devices never share a server port.
const crypto = require('node:crypto');

function portsFor(device) {
  const hash = crypto.createHash('sha256').update(String(device)).digest();
  const slot = hash.readUInt16BE(0) % 500;
  const base = 4730 + slot * 10;
  return { server: base, wda: base + 1, system: base + 2 };
}

function slugFor(device) {
  return String(device).replace(/[^a-zA-Z0-9-]/g, '-');
}

if (require.main === module) {
  const device = process.argv[2];
  if (!device) {
    console.error('usage: ports.js <device>');
    process.exit(1);
  }
  const p = portsFor(device);
  console.log(
    `APPIUM_PORT=${p.server}\nAPPIUM_WDA_PORT=${p.wda}\nAPPIUM_SYSTEM_PORT=${p.system}\nAPPIUM_DEVICE_SLUG=${slugFor(device)}`
  );
}

module.exports = { portsFor, slugFor };
