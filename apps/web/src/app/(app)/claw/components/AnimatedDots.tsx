'use client';

import { useEffect, useState } from 'react';

export function AnimatedDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setCount(c => (c % 3) + 1), 500);
    return () => clearInterval(id);
  }, []);
  // Pad with invisible characters to keep width constant
  const visible = '.'.repeat(count);
  const hidden = '.'.repeat(3 - count);
  return (
    <span>
      {visible}
      <span className="invisible">{hidden}</span>
    </span>
  );
}
