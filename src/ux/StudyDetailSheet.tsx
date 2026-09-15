import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, PointerEvent, ReactNode, RefObject } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  X,
} from 'lucide-react';
import './study-detail-sheet.css';

type Position = 'collapsed' | 'half' | 'expanded';
const positions: Position[] = ['collapsed', 'half', 'expanded'];
const positionLabels = {
  collapsed: 'Detail je sbalený.',
  half: 'Detail zabírá polovinu dostupné plochy.',
  expanded: 'Detail je roztažený.',
};
const collapsedHeight = 64;
export type StudyDetailSheetControls = { collapse: () => void };

export default function StudyDetailSheet({
  containerRef,
  controlsRef,
  selectionKey,
  title,
  label,
  onClose,
  children,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  controlsRef: RefObject<StudyDetailSheetControls | null>;
  selectionKey: string;
  title: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [compact, setCompact] = useState(
    () => window.matchMedia('(max-width: 680px)').matches,
  );
  const [position, setPosition] = useState<Position>('half');
  const [dimensions, setDimensions] = useState({
    maximum: collapsedHeight,
    half: collapsedHeight,
  });
  const maximumHeight = dimensions.maximum;
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<Element | null>(document.activeElement);
  const suppressClick = useRef(false);
  const hintId = useId();
  const contentId = useId();
  const drag = useRef<{
    pointerId: number;
    y: number;
    height: number;
    lastHeight: number;
    moved: boolean;
  } | null>(null);
  const heights = {
    collapsed: collapsedHeight,
    half: dimensions.half,
    expanded: maximumHeight,
  };
  const height = dragHeight ?? heights[position];
  const collapsed = compact && height <= collapsedHeight;
  useImperativeHandle(
    controlsRef,
    () => ({ collapse: () => setPosition('collapsed') }),
    [],
  );

  useEffect(() => {
    const media = window.matchMedia('(max-width: 680px)');
    const update = () => {
      setCompact(media.matches);
      drag.current = null;
      setDragHeight(null);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const sheet = containerRef.current;
    const workspace = sheet?.parentElement;
    if (!compact || !sheet || !workspace) return;
    const measure = () => {
      const bottom = parseFloat(getComputedStyle(sheet).bottom) || 0;
      const maximum = Math.max(
        collapsedHeight,
        window.innerHeight - bottom - 16,
      );
      const workspaceSpace = workspace.clientHeight - bottom - 16;
      const half = Math.min(
        maximum,
        Math.max(220, (workspaceSpace + collapsedHeight) / 2),
      );
      setDimensions((current) =>
        current.maximum === maximum && current.half === half
          ? current
          : { maximum, half },
      );
      drag.current = null;
      setDragHeight(null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [compact, containerRef]);

  useLayoutEffect(() => {
    // A new map selection reveals its detail; navigation inside an open sheet
    // preserves the reading height and the mounted scroll container.
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      !containerRef.current?.contains(active)
    ) {
      originRef.current = active;
    }
    setPosition((current) => (current === 'collapsed' ? 'half' : current));
  }, [selectionKey, containerRef]);

  useLayoutEffect(() => {
    if (collapsed && contentRef.current?.contains(document.activeElement)) {
      gripRef.current?.focus({ preventScroll: true });
    }
  }, [collapsed]);

  const close = () => {
    const workspace = containerRef.current?.parentElement;
    const origin = originRef.current;
    onClose();
    requestAnimationFrame(() => {
      const target =
        origin?.isConnected && origin.checkVisibility()
          ? origin
          : workspace?.querySelector('.ux-mobile-sites-toggle');
      if (target instanceof HTMLElement || target instanceof SVGElement) {
        target.focus({ preventScroll: true });
      }
    });
  };
  const cancelDrag = () => {
    if (!drag.current) return;
    suppressClick.current = drag.current.moved;
    drag.current = null;
    setDragHeight(null);
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    suppressClick.current = current.moved;
    if (current.moved) {
      const nearest = positions.reduce((best, next) =>
        Math.abs(heights[next] - current.lastHeight) <
        Math.abs(heights[best] - current.lastHeight)
          ? next
          : best,
      );
      setPosition(nearest);
    }
    drag.current = null;
    setDragHeight(null);
  };

  return (
    <div
      ref={containerRef}
      className="ux-floating-detail ux-detail-sheet"
      data-map-obstacle
      data-sheet-position={position}
      data-sheet-collapsed={collapsed}
      data-sheet-dragging={dragHeight !== null}
      style={{ '--ux-detail-height': `${height}px` } as CSSProperties}
      onKeyDown={(event) => {
        if (compact && event.key === 'Escape' && !event.defaultPrevented) {
          if (
            containerRef.current?.parentElement?.querySelector(
              '.ux-map-control.is-tooltip-open',
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="ux-mobile-detail-header">
        <button
          ref={gripRef}
          type="button"
          className="ux-mobile-detail-grip"
          aria-label="Změnit výšku detailu"
          aria-describedby={hintId}
          aria-controls={contentId}
          aria-expanded={!collapsed}
          onClick={(event) => {
            if (suppressClick.current) {
              suppressClick.current = false;
              event.preventDefault();
              return;
            }
            setPosition(position === 'half' ? 'expanded' : 'half');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ')
              suppressClick.current = false;
            const index = positions.indexOf(position);
            const next =
              event.key === 'ArrowUp'
                ? positions[Math.min(2, index + 1)]
                : event.key === 'ArrowDown'
                  ? positions[Math.max(0, index - 1)]
                  : event.key === 'Home'
                    ? 'collapsed'
                    : event.key === 'End'
                      ? 'expanded'
                      : null;
            if (!next) return;
            event.preventDefault();
            setPosition(next);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            suppressClick.current = false;
            drag.current = {
              pointerId: event.pointerId,
              y: event.clientY,
              height,
              lastHeight: height,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const delta = current.y - event.clientY;
            if (!current.moved && Math.abs(delta) < 6) return;
            current.moved = true;
            current.lastHeight = Math.max(
              collapsedHeight,
              Math.min(maximumHeight, current.height + delta),
            );
            setDragHeight(current.lastHeight);
          }}
          onPointerUp={finishDrag}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={cancelDrag}
        >
          <small>{label}</small>
          <strong title={title}>{title}</strong>
        </button>
        <button
          type="button"
          className="ux-icon"
          aria-label={
            position === 'collapsed' ? 'Otevřít detail' : 'Sbalit detail'
          }
          aria-expanded={position !== 'collapsed'}
          aria-controls={contentId}
          onClick={() =>
            setPosition(position === 'collapsed' ? 'half' : 'collapsed')
          }
        >
          {position === 'collapsed' ? (
            <ChevronUp size={19} />
          ) : (
            <ChevronDown size={19} />
          )}
        </button>
        {position !== 'collapsed' && (
          <button
            type="button"
            className="ux-icon"
            aria-label={
              position === 'expanded'
                ? 'Zmenšit detail na polovinu'
                : 'Roztáhnout detail'
            }
            onClick={() =>
              setPosition(position === 'expanded' ? 'half' : 'expanded')
            }
          >
            {position === 'expanded' ? (
              <ChevronsDown size={19} />
            ) : (
              <ChevronsUp size={19} />
            )}
          </button>
        )}
        <button
          type="button"
          className="ux-icon"
          aria-label="Zavřít detail"
          onClick={close}
        >
          <X size={19} />
        </button>
        <span id={hintId} className="ux-sr-only">
          {positionLabels[position]} Tažením nebo šipkami změň výšku panelu.
          Escape zavře detail.
        </span>
      </div>
      <div
        ref={contentRef}
        id={contentId}
        className="ux-mobile-detail-content"
        inert={collapsed}
      >
        {children}
      </div>
    </div>
  );
}
