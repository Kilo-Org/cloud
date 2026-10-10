import { describe, expect, it } from 'bun:test';
import { workloadStatsFields } from './workload-stats-fields.js';

describe('workloadStatsFields', () => {
  it('reports the tools and server memory split next to the parent counters', () => {
    expect(
      workloadStatsFields({
        parent: {
          currentBytes: 11_000,
          peakBytes: 11_500,
          anonBytes: 6_700,
          fileBytes: 3_750,
          shmemBytes: 1_200,
          memoryMaxEvents: 3,
          pressureAvailable: true,
          oomKills: 1,
          oomGroupKills: 0,
          cpuUsageUsec: 900,
        },
        tools: {
          currentBytes: 9_000,
          peakBytes: 9_400,
          anonBytes: 5_000,
          fileBytes: 3_500,
          shmemBytes: 1_200,
          oomKills: 1,
          oomGroupKills: 0,
          cpuUsageUsec: 800,
          ioReadBytes: 70,
          ioWriteBytes: 30,
          pressureAvailable: true,
        },
        server: {
          currentBytes: 2_000,
          peakBytes: 2_100,
          anonBytes: 1_700,
          fileBytes: 250,
          shmemBytes: 0,
          oomKills: 0,
          oomGroupKills: 0,
          cpuUsageUsec: 100,
          pressureAvailable: true,
        },
      })
    ).toEqual({
      oomKills: 1,
      oomGroupKills: 0,
      toolOomKills: 1,
      serverOomKills: 0,
      currentBytes: 11_000,
      peakBytes: 11_500,
      anonBytes: 6_700,
      fileBytes: 3_750,
      shmemBytes: 1_200,
      memoryMaxEvents: 3,
      cpuUsageUsec: 900,
      toolCurrentBytes: 9_000,
      toolPeakBytes: 9_400,
      toolAnonBytes: 5_000,
      toolFileBytes: 3_500,
      toolShmemBytes: 1_200,
      toolCpuUsageUsec: 800,
      toolIoReadBytes: 70,
      toolIoWriteBytes: 30,
      serverCurrentBytes: 2_000,
      serverPeakBytes: 2_100,
      serverAnonBytes: 1_700,
      serverFileBytes: 250,
      serverShmemBytes: 0,
      serverCpuUsageUsec: 100,
      pressureAvailable: true,
    });
  });
});
