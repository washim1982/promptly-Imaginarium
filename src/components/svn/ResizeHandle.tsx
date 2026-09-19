import { useEffect, useRef, useState } from 'react';

interface ResizeHandleProps {
  /** Current width of the panel this handle controls. */
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
  /** "left": the panel is left of the handle (dragging right grows it); "right": the opposite. */
  side: 'left' | 'right';
  label: string;
}

const KEYBOARD_STEP = 16;

export function ResizeHandle({ width, onResize, onReset, side, label }: ResizeHandleProps) {
  const [active, setActive] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const direction = side === 'left' ? 1 : -1;

  // Move/up are tracked on window rather than via pointer capture, so a fast
  // drag that outruns the 10px handle still resizes and still ends cleanly.
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    setActive(true);
    document.body.classList.add('svn-is-resizing');

    const onMove = (ev: PointerEvent) => onResize(startWidth + (ev.clientX - startX) * direction);
    const onUp = () => cleanup();
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('svn-is-resizing');
      setActive(false);
      cleanupRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    cleanupRef.current = cleanup;
  }

  useEffect(() => () => cleanupRef.current?.(), []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowLeft') onResize(width - KEYBOARD_STEP * direction);
    else if (e.key === 'ArrowRight') onResize(width + KEYBOARD_STEP * direction);
    else return;
    e.preventDefault();
  }

  return (
    <div
      className={`svn-resize ${active ? 'svn-resize--active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
