import { useState, useEffect, useRef, useCallback } from 'react';

export function useResizableSidebar(initialWidth = 220, min = 140, max = 500) {
  const [width, setWidth] = useState(initialWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();
      const newWidth = dragRef.current.startWidth + (e.clientX - dragRef.current.startX);
      setWidth(Math.min(Math.max(newWidth, min), max));
    };
    const handleMouseUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
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
  }, [min, max]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { startX: e.clientX, startWidth: width };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width]
  );

  return { width, startDrag };
}
