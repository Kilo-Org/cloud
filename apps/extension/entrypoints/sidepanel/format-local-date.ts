const padCalendarPart = (value: number): string => String(value).padStart(2, '0');

export const formatLocalListDate = (timestamp: number): string => {
  const date = new Date(timestamp);

  return `${date.getFullYear()}-${padCalendarPart(date.getMonth() + 1)}-${padCalendarPart(date.getDate())}`;
};
