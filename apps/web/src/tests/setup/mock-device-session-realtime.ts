jest.mock('@/lib/auth/device-session-realtime', () => ({
  scheduleDeviceSessionRealtimeClose: jest.fn(async () => {}),
}));
