// Drag handle for the chat sidebar's right edge.
//
// Same interaction as SVN Studio's panel handles: drag to resize, double-click
// to reset, arrow keys when focused. Move/up are tracked on window rather than
// through pointer capture, so a fast drag that outruns the handle still
// resizes and still ends cleanly.

import { useEffect, useRef, useState } from 'react';

const KEYBOARD_STEP = 16;

export function SidebarResizer({
  width,
  onResize,
  onReset,
  onCollapse,
  collapseAt,
}: {
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
  /**
  * Dragging narrower than `collapseAt` snaps to the icon rail. Gets the width
  * from before the drag, so expanding again restores what the user had.
  */
  onCollapse: (restoreWidth: number) => void;
  collapseAt: number;
}) {
  const [active, setActive] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    setActive(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setActive(false);
      cleanupRef.current = null;
    };
    const move = (ev: PointerEvent) => {
      const next = startWidth + (ev.clientX - startX);
      if (next < collapseAt) {
        cleanup();
        onCollapse(startWidth);
        return;
      }
      onResize(next);
    };
    const up = () => cleanup();

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    cleanupRef.current = cleanup;
  }

  // A drag in progress must not outlive the component.
  useEffect(() => () => cleanupRef.current?.(), []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowLeft') onResize(width - KEYBOARD_STEP);
    else if (e.key === 'ArrowRight') onResize(width + KEYBOARD_STEP);
    else if (e.key === 'Enter' || e.key === ' ') onCollapse(width);
    else return;
    e.preventDefault();
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="group relative -mx-1.5 w-3 shrink-0 cursor-col-resize focus:outline-none"
    >
      {/* Thin line, lit while dragging, on hover, or when focused by keyboard. */}
      <span
        className={`pointer-events-none absolute inset-y-4 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors ${
          active
            ? 'bg-[var(--color-neon)]'
            : 'bg-transparent group-hover:bg-white/20 group-focus-visible:bg-[var(--color-neon)]'
        }`}
      />
    </div>
  );
}
