type StatusSpinnerProps = {
  className?: string;
};

// Pre-compute random animation parameters at module level so they're stable across renders
const squareAnimations = Array.from({ length: 16 }, () => ({
  delay: Math.random() * 1.5,
  duration: 1 + Math.random(),
}));

const CORNER_INDICES = new Set([0, 3, 12, 15]);
const INNER_INDICES = new Set([5, 6, 9, 10]);

export function StatusSpinner({ className }: StatusSpinnerProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      {Array.from({ length: 16 }, (_, i) => {
        const row = Math.floor(i / 4);
        const col = i % 4;
        const x = col * 6;
        const y = row * 6;
        const { delay, duration } = squareAnimations[i];

        if (CORNER_INDICES.has(i)) {
          return <rect key={i} x={x} y={y} width={5} height={5} rx={2} opacity={0} />;
        }

        const animationName = INNER_INDICES.has(i) ? 'pulse-opacity' : 'pulse-opacity-dim';

        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={5}
            height={5}
            rx={2}
            style={{
              animationName,
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`,
              animationIterationCount: 'infinite',
              animationTimingFunction: 'ease-in-out',
            }}
          />
        );
      })}
    </svg>
  );
}
