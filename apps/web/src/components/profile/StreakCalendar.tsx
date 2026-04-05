'use client';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface StreakCalendarProps {
  streakData?: { date: string; count: number }[];
  currentStreak?: number;
}

const INTENSITY_LEVELS = [
  { color: 'bg-slate-800', min: 0, max: 0, label: 'No requests' },
  { color: 'bg-yellow-900/30', min: 1, max: 10, label: '1-10 requests' },
  { color: 'bg-orange-800/50', min: 11, max: 30, label: '11-30 requests' },
  { color: 'bg-orange-600', min: 31, max: 80, label: '31-80 requests' },
  { color: 'bg-orange-400', min: 81, max: Infinity, label: '81+ requests' },
] as const;

// If no data is provided, show empty calendar for the past 12 weeks
const generateEmptyData = () => {
  const data: { date: string; count: number }[] = [];
  const today = new Date();

  for (let i = 83; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);

    data.push({
      date: date.toISOString().split('T')[0],
      count: 0,
    });
  }
  return data;
};

const getIntensityClass = (count: number) => {
  const level = INTENSITY_LEVELS.find(level => count >= level.min && count <= level.max);
  return level?.color || INTENSITY_LEVELS[0].color;
};

export function StreakCalendar({ streakData, currentStreak: _currentStreak }: StreakCalendarProps) {
  const data = streakData || generateEmptyData();

  // Organize data by week (columns) - ensure we start from Sunday
  const organizedData: Array<Array<{ date: string; count: number } | null>> = [];

  if (data.length > 0) {
    const firstDate = new Date(data[0].date + 'T00:00:00');
    const firstDayOfWeek = firstDate.getDay();

    // Add null padding for days before the first date
    const firstWeek: Array<{ date: string; count: number } | null> = [];
    for (let i = 0; i < firstDayOfWeek; i++) {
      firstWeek.push(null);
    }

    // Add the actual data
    let currentWeek = firstWeek;
    for (const day of data) {
      currentWeek.push(day);
      if (currentWeek.length === 7) {
        organizedData.push(currentWeek);
        currentWeek = [];
      }
    }

    // Add the last incomplete week if needed
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push(null);
      }
      organizedData.push(currentWeek);
    }
  }

  // Generate month headers aligned with weeks
  const getMonthHeaders = () => {
    const headers: Array<{ month: string; colspan: number }> = [];
    let currentMonth = '';
    let colspan = 0;

    organizedData.forEach(week => {
      const validDay = week.find(day => day !== null);
      if (!validDay) return;

      const date = new Date(validDay.date + 'T00:00:00');
      const monthName = date.toLocaleDateString('en-US', { month: 'short' });

      if (monthName !== currentMonth) {
        if (currentMonth && colspan > 0) {
          headers.push({ month: currentMonth, colspan });
        }
        currentMonth = monthName;
        colspan = 1;
      } else {
        colspan++;
      }
    });

    if (currentMonth && colspan > 0) {
      headers.push({ month: currentMonth, colspan });
    }

    return headers;
  };

  const monthHeaders = getMonthHeaders();
  const dayLabels = [
    { label: 'Sun', row: 0 },
    { label: 'Mon', row: 1 },
    { label: 'Tue', row: 2 },
    { label: 'Wed', row: 3 },
    { label: 'Thu', row: 4 },
    { label: 'Fri', row: 5 },
    { label: 'Sat', row: 6 },
  ];

  const formatTooltipDate = (dateString: string) => {
    const dateObj = new Date(dateString + 'T00:00:00');
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const month = monthNames[dateObj.getMonth()];
    const day = dateObj.getDate();
    const year = dateObj.getFullYear();
    return `${month} ${day}, ${year}`;
  };

  return (
    <div className="w-full space-y-4">
      <div className="calendar-container relative inline-block">
        <div className="mb-1 flex gap-1 pl-9">
          {monthHeaders.map((header, index) => (
            <div
              key={index}
              className="text-xs text-slate-400"
              style={{ width: `${header.colspan * 20 + (header.colspan - 1) * 4}px` }}
            >
              {header.month}
            </div>
          ))}
        </div>

        <div className="flex">
          <div
            className="mr-2 grid gap-1"
            style={{ gridTemplateRows: 'repeat(7, 16px)', width: '24px' }}
          >
            {dayLabels.map(({ label, row }) => (
              <div
                key={label}
                className="flex h-4 items-center text-xs text-slate-400"
                style={{ gridRow: row + 1 }}
              >
                {label}
              </div>
            ))}
          </div>

          <TooltipProvider delayDuration={0}>
            <div
              className="grid grid-flow-col gap-1"
              style={{ gridTemplateRows: 'repeat(7, 16px)' }}
            >
              {organizedData.map((week, weekIndex) =>
                week.map((day, dayIndex) => {
                  const cell = (
                    <div
                      key={`${weekIndex}-${dayIndex}`}
                      className={`h-4 w-4 rounded-sm transition-all ${
                        day
                          ? `${getIntensityClass(day.count)} cursor-pointer hover:ring-2 hover:ring-orange-500 hover:ring-offset-1 hover:ring-offset-slate-900`
                          : ''
                      }`}
                      style={{
                        gridRow: dayIndex + 1,
                        gridColumn: weekIndex + 1,
                      }}
                    />
                  );

                  if (!day) return cell;

                  return (
                    <Tooltip key={`${weekIndex}-${dayIndex}`}>
                      <TooltipTrigger asChild>{cell}</TooltipTrigger>
                      <TooltipContent className="border border-slate-700 bg-slate-800 text-white">
                        <div>
                          <div className="font-medium">{formatTooltipDate(day.date)}</div>
                          <div className="text-xs text-slate-400">
                            {day.count === 0
                              ? 'No requests'
                              : `${day.count} request${day.count !== 1 ? 's' : ''}`}
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })
              )}
            </div>
          </TooltipProvider>
        </div>

        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-slate-400">
          <span>Less</span>
          <div className="flex gap-1">
            {INTENSITY_LEVELS.map((level, index) => (
              <div
                key={index}
                className={`h-4 w-4 ${level.color} cursor-help rounded-sm`}
                title={level.label}
              />
            ))}
          </div>
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
