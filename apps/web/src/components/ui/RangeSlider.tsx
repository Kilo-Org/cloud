'use client';
export function RangeSlider({
  min,
  max,
  value,
  onChange,
  step = 1,
  formatValue = v => v.toString(),
}: {
  min: number;
  max: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  step?: number;
  formatValue?: (value: number) => string;
}) {
  return (
    <div className="space-y-3">
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{formatValue(value[0])}</span>
        <span>{formatValue(value[1])}</span>
      </div>

      {/* Separate sliders for better usability */}
      <div className="space-y-3">
        <div>
          <label className="text-muted-foreground mb-1 block text-xs">Minimum</label>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value[0]}
            onChange={e => onChange([Math.min(+e.target.value, value[1]), value[1]])}
            className="[&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:bg-primary h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full"
          />
        </div>

        <div>
          <label className="text-muted-foreground mb-1 block text-xs">Maximum</label>
          <input
            type="range"
            min={min} // Min can't go below current min value
            max={max}
            step={step}
            value={value[1]}
            onChange={e => onChange([value[0], Math.max(+e.target.value, value[0])])}
            className="[&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:bg-primary h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full"
          />
        </div>
      </div>
    </div>
  );
}
