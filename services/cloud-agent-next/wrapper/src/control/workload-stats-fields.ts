import type { WorkloadStats } from './workload-cgroup.js';

type StatsFields = Record<string, number | boolean>;

function definedFields(entries: Record<string, number | boolean | undefined>): StatsFields {
  const fields: StatsFields = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

/**
 * Counters for a `control.workload` stats record. The per-child memory split shows whether Kilo
 * grew or tools squeezed it when the parent sits at its cap. Memory a direct Kilo child charges
 * before the sweep moves it into tools stays charged to the server.
 */
export function workloadStatsFields(input: {
  parent: WorkloadStats;
  tools: WorkloadStats;
  server: WorkloadStats;
}): StatsFields {
  const { parent, tools, server } = input;
  return definedFields({
    oomKills: parent.oomKills,
    oomGroupKills: parent.oomGroupKills,
    toolOomKills: tools.oomKills,
    serverOomKills: server.oomKills,
    currentBytes: parent.currentBytes,
    peakBytes: parent.peakBytes,
    anonBytes: parent.anonBytes,
    fileBytes: parent.fileBytes,
    shmemBytes: parent.shmemBytes,
    pressureSomeTotal: parent.pressureSomeTotal,
    pressureFullTotal: parent.pressureFullTotal,
    memoryMaxEvents: parent.memoryMaxEvents,
    memoryOomEvents: parent.memoryOomEvents,
    cpuUsageUsec: parent.cpuUsageUsec,
    cpuThrottledUsec: parent.cpuThrottledUsec,
    cpuThrottleCount: parent.cpuThrottleCount,
    ioReadBytes: parent.ioReadBytes,
    ioWriteBytes: parent.ioWriteBytes,
    toolCurrentBytes: tools.currentBytes,
    toolPeakBytes: tools.peakBytes,
    toolAnonBytes: tools.anonBytes,
    toolFileBytes: tools.fileBytes,
    toolShmemBytes: tools.shmemBytes,
    toolCpuUsageUsec: tools.cpuUsageUsec,
    toolIoReadBytes: tools.ioReadBytes,
    toolIoWriteBytes: tools.ioWriteBytes,
    serverCurrentBytes: server.currentBytes,
    serverPeakBytes: server.peakBytes,
    serverAnonBytes: server.anonBytes,
    serverFileBytes: server.fileBytes,
    serverShmemBytes: server.shmemBytes,
    serverCpuUsageUsec: server.cpuUsageUsec,
    pressureAvailable: parent.pressureAvailable,
  });
}
