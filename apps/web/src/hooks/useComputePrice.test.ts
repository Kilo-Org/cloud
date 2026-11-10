import { useComputePrice } from './useComputePrice';

let mockRates: { instance: string; hourlyUsd: number | null; available: boolean }[] | undefined;

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockRates }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({ computeBilling: { rates: { queryOptions: () => ({}) } } }),
}));

const destination = {
  provider: { id: 'cloudflare-containers', account: 'kilo' },
  instanceType: 'standard-3',
} as const;

describe('useComputePrice', () => {
  beforeEach(() => {
    mockRates = [{ instance: 'standard-3', hourlyUsd: 0.18, available: true }];
  });

  it('distinguishes an unavailable price from an unavailable sandbox', () => {
    mockRates = [{ instance: 'standard-3', hourlyUsd: 0.18, available: false }];
    expect(useComputePrice()(destination)).toBe('Price unavailable');
  });

  it('labels missing SKU pricing consistently', () => {
    mockRates = [{ instance: 'standard-3', hourlyUsd: null, available: false }];
    expect(useComputePrice()(destination)).toBe('Price unavailable');
  });

  it('formats an available hourly rate', () => {
    expect(useComputePrice()(destination)).toBe('~$0.18/hr');
  });

  it('omits the price while rates are loading', () => {
    mockRates = undefined;
    expect(useComputePrice()(destination)).toBeUndefined();
  });

  it('omits the price for providers that bill compute themselves', () => {
    expect(
      useComputePrice()({ provider: { id: 'vercel', account: 'byoc' }, instanceType: 'small' })
    ).toBeUndefined();
  });
});
