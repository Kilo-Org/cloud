import { useState, useEffect, useRef, useCallback } from 'react';
import { safeLocalStorage } from '@/lib/localStorage';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function useResizableSidebar(initialWidth = 220, min = 140, max = 500, storageKey?: string) {
  const [width, setWidth] = useState(initialWidth);
  const dragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);

  useEffect(() => {
    if (!storageKey) return;
    const stored = safeLocalStorage.getItem(storageKey);
    if (stored === null || stored.trim() === '') return;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return;
    setWidth(clamp(parsed, min, max));
  }, [storageKey, min, max]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();
      const next = clamp(
        dragRef.current.startWidth + (e.clientX - dragRef.current.startX),
        min,
        max
      );
      dragRef.current.width = next;
      setWidth(next);
    };
    const handleMouseUp = () => {
      if (!dragRef.current) return;
      const draggedWidth = dragRef.current.width;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (storageKey) safeLocalStorage.setItem(storageKey, String(draggedWidth));
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [min, max, storageKey]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { startX: e.clientX, startWidth: width, width };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width]
  );

  return { width, startDrag };
}
