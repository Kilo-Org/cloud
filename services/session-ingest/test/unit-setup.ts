import { vi } from 'vitest';

vi.mock('cloudflare:durable-objects', () => ({ retryable: vi.fn() }));
