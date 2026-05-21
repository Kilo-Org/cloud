import { DEFAULT_TIME_WINDOW, TIME_WINDOW_OPTIONS, type TimeWindow } from './types';

export function parseTimeWindow(value: string | null): TimeWindow {
  if (value && (TIME_WINDOW_OPTIONS as readonly string[]).includes(value)) {
    return value as TimeWindow;
  }
  return DEFAULT_TIME_WINDOW;
}

export function timeWindowToInterval(window: TimeWindow): string | null {
  switch (window) {
    case '7d':
      return '7 days';
    case '30d':
      return '30 days';
    case '90d':
      return '90 days';
    case 'all':
      return null;
  }
}
