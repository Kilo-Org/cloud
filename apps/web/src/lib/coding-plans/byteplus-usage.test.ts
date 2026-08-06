import { getBytePlusSeatUsage } from '@/lib/coding-plans/byteplus-control-plane';
import { getBytePlusUsage, normalizeBytePlusUsage } from '@/lib/coding-plans/byteplus-usage';
import { CodingPlanUsageError } from '@/lib/coding-plans/usage-contract';

jest.mock('@/lib/coding-plans/byteplus-control-plane', () => ({
  BytePlusControlPlaneError: class BytePlusControlPlaneError extends Error {
    code: string;

    constructor(code: string) {
      super('safe');
      this.code = code;
    }
  },
  getBytePlusSeatUsage: jest.fn(),
}));

const mockedGetBytePlusSeatUsage = jest.mocked(getBytePlusSeatUsage);
const fetchedAt = '2026-08-06T12:00:00.000Z';

beforeEach(() => {
  mockedGetBytePlusSeatUsage.mockReset();
});

describe('BytePlus usage normalization', () => {
  it('normalizes all three ordered windows and omits startsAt', () => {
    expect(
      normalizeBytePlusUsage(
        {
          shortTermUsage: 12.5,
          weeklyUsage: 55,
          monthlyUsage: 99.25,
          shortTermResetMilestone: 1_781_280_000_000,
          weeklyResetMilestone: 1_781_884_800_000,
          monthlyResetMilestone: 1_783_000_000_000,
        },
        fetchedAt
      )
    ).toEqual({
      fetchedAt,
      windows: [
        {
          id: 'short_term',
          remainingPercent: 87.5,
          resetsAt: new Date(1_781_280_000_000).toISOString(),
          period: { unit: 'hour', value: 5 },
        },
        {
          id: 'weekly',
          remainingPercent: 45,
          resetsAt: new Date(1_781_884_800_000).toISOString(),
          period: { unit: 'week', value: 1 },
        },
        {
          id: 'monthly',
          remainingPercent: 0.75,
          resetsAt: new Date(1_783_000_000_000).toISOString(),
          period: { unit: 'month', value: 1 },
        },
      ],
    });
  });

  it('clamps zero, full, and above-full usage to valid remaining percentages', () => {
    expect(
      normalizeBytePlusUsage(
        {
          shortTermUsage: 0,
          weeklyUsage: 100,
          monthlyUsage: 140,
          shortTermResetMilestone: 1_781_280_000_000,
          weeklyResetMilestone: 1_781_884_800_000,
          monthlyResetMilestone: 1_783_000_000_000,
        },
        fetchedAt
      ).windows.map(window => window.remainingPercent)
    ).toEqual([100, 0, 0]);
  });

  it('keeps complete pairs, skips invalid pairs, and requires one window', () => {
    expect(
      normalizeBytePlusUsage(
        {
          shortTermUsage: -1,
          shortTermResetMilestone: 1_781_280_000_000,
          weeklyUsage: 50,
          weeklyResetMilestone: 0,
          monthlyUsage: 25,
          monthlyResetMilestone: 1_783_000_000_000,
        },
        fetchedAt
      ).windows
    ).toEqual([
      {
        id: 'monthly',
        remainingPercent: 75,
        resetsAt: new Date(1_783_000_000_000).toISOString(),
        period: { unit: 'month', value: 1 },
      },
    ]);

    expect(() =>
      normalizeBytePlusUsage(
        {
          shortTermUsage: Number.NaN,
          shortTermResetMilestone: 1_781_280_000_000,
          weeklyUsage: 25,
          weeklyResetMilestone: Number.NaN,
          monthlyUsage: 1,
          monthlyResetMilestone: -1,
        },
        fetchedAt
      )
    ).toThrow(CodingPlanUsageError);
  });

  it('calls the control-plane client and returns only the normalized snapshot', async () => {
    mockedGetBytePlusSeatUsage.mockResolvedValue({
      shortTermUsage: 10,
      shortTermResetMilestone: 1_781_280_000_000,
      weeklyUsage: 20,
      weeklyResetMilestone: 1_781_884_800_000,
      monthlyUsage: 30,
      monthlyResetMilestone: 1_783_000_000_000,
    });

    const result = await getBytePlusUsage('seat-123');

    expect(mockedGetBytePlusSeatUsage).toHaveBeenCalledWith('seat-123');
    expect(result.windows.map(window => window.id)).toEqual(['short_term', 'weekly', 'monthly']);
    expect(JSON.stringify(result)).not.toContain('SeatID');
  });
});
