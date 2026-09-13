import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import {
  Expand,
  Layers2,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { GraphExternalLink } from './ExternalLink';
import ArrowHead from './ArrowHead';
import { pageStatusLabel, siteUrl, useGraphData } from './graph-data';
import type { Link, Page, Selection, Site } from './data';
import ConnectionStroke from './ConnectionStroke';
import {
  connectionStrengthLabel,
  isFineConnectionStyle,
} from './connectionStyles';
import type { ConnectionStyleId } from './connectionStyles';

type Props = {
  sites: Site[];
  links: Link[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  expanded: string[];
  focusedExpanded: string[];
  onAutoExpandedChange: (value: boolean) => void;
  onFocusSite: (id: string) => void;
  onExpandedChange: (ids: string[]) => void;
  running: boolean;
  resetKey: number;
  connectionStyle: ConnectionStyleId;
};

type Point = { x: number; y: number };
const PAGE_CARD = { x: -15, y: -14, width: 138, height: 29 };

function pageLinkPath(
  from: Point,
  control: Point,
  to: Point,
  expanded: boolean,
) {
  let end = to;
  let trimmedControl = control;
  if (expanded) {
    // Leave room for the head's half-width and outline at any approach angle.
    const padding = 8;
    const left = to.x + PAGE_CARD.x - padding;
    const top = to.y + PAGE_CARD.y - padding;
    const right = left + PAGE_CARD.width + 2 * padding;
    const bottom = top + PAGE_CARD.height + 2 * padding;
    const pointAt = (t: number) => ({
      x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x,
      y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y,
    });
    let outside = 0;
    let inside = 1;
    for (let iteration = 0; iteration < 24; iteration++) {
      const t = (outside + inside) / 2;
      const point = pointAt(t);
      if (
        point.x >= left &&
        point.x <= right &&
        point.y >= top &&
        point.y <= bottom
      ) {
        inside = t;
      } else {
        outside = t;
      }
    }
    end = pointAt(outside);
    // Subdivide the quadratic so clipping preserves its curve and end tangent.
    trimmedControl = {
      x: from.x + outside * (control.x - from.x),
      y: from.y + outside * (control.y - from.y),
    };
  }
  return `M ${from.x} ${from.y} Q ${trimmedControl.x} ${trimmedControl.y} ${end.x} ${end.y}`;
}

function activate(event: KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

function calculatePageLayout(
  site: Site,
  compact: boolean,
  pages: Page[],
  rowGap: number,
) {
  const count = pages.filter((page) => page.siteId === site.id).length;
  const columns = count > 6 ? (compact ? 3 : 4) : 2;
  const rows = Math.ceil(count / columns);
  const width = columns * 144 - 6;
  const radius = Math.max(
    122,
    Math.ceil(Math.hypot(width / 2, ((rows - 1) * rowGap) / 2 + 15) + 25),
  );
  return { columns, rows, width, radius };
}

function calculatePagePosition(
  page: Page,
  site: Site,
  compact: boolean,
  pages: Page[],
  rowGap: number,
) {
  const index = pages
    .filter((item) => item.siteId === site.id)
    .findIndex((item) => item.id === page.id);
  const { columns, rows, width } = calculatePageLayout(
    site,
    compact,
    pages,
    rowGap,
  );
  return {
    x: site.x - width / 2 + 15 + (index % columns) * 144,
    y:
      site.y - ((rows - 1) * rowGap) / 2 + Math.floor(index / columns) * rowGap,
  };
}

type SiteBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  domainWidth?: number;
};

const SITE_GAP = 32;

function radialClearance(a: SiteBounds, b: SiteBounds, dx: number, dy: number) {
  const x =
    dx > 0.000001
      ? (a.right - b.left + SITE_GAP) / dx
      : dx < -0.000001
        ? (b.right - a.left + SITE_GAP) / -dx
        : Infinity;
  const y =
    dy > 0.000001
      ? (a.bottom - b.top + SITE_GAP) / dy
      : dy < -0.000001
        ? (b.bottom - a.top + SITE_GAP) / -dy
        : Infinity;
  // Separating either axis is sufficient to clear two rectangular footprints.
  return Math.min(x, y);
}

function balanceSites(sites: Site[], bounds: Record<string, SiteBounds>) {
  const origins = separateSites(
    sites.filter((site) => site.scanned),
    bounds,
  );
  const targets = sites.filter((site) => !site.scanned);
  if (origins.length === 0 || targets.length === 0) return sites;
  const center = {
    x: origins.reduce((sum, site) => sum + site.x, 0) / origins.length,
    y: origins.reduce((sum, site) => sum + site.y, 0) / origins.length,
  };
  const innerBounds = {
    left: Math.min(
      ...origins.map((site) => site.x - center.x + bounds[site.id].left),
    ),
    top: Math.min(
      ...origins.map((site) => site.y - center.y + bounds[site.id].top),
    ),
    right: Math.max(
      ...origins.map((site) => site.x - center.x + bounds[site.id].right),
    ),
    bottom: Math.max(
      ...origins.map((site) => site.y - center.y + bounds[site.id].bottom),
    ),
  };
  const directions = targets.map((site, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / targets.length;
    return { site, x: Math.cos(angle), y: Math.sin(angle) };
  });
  let radius = 280;
  for (let first = 0; first < directions.length; first++) {
    const a = directions[first];
    radius = Math.max(
      radius,
      radialClearance(innerBounds, bounds[a.site.id], a.x, a.y),
    );
    for (let second = first + 1; second < directions.length; second++) {
      const b = directions[second];
      radius = Math.max(
        radius,
        radialClearance(
          bounds[a.site.id],
          bounds[b.site.id],
          b.x - a.x,
          b.y - a.y,
        ),
      );
    }
  }
  // Enlarge the entire ring to fit labels without distorting its equal angles.
  const positions = new Map(
    directions.map(({ site, x, y }) => [
      site.id,
      {
        x: center.x + x * (radius + 1),
        y: center.y + y * (radius + 1),
      },
    ]),
  );
  for (const origin of origins)
    positions.set(origin.id, { x: origin.x, y: origin.y });
  return sites.map((site) => ({ ...site, ...positions.get(site.id) }));
}

function separateSites(
  sites: Site[],
  bounds: Record<string, SiteBounds>,
  anchorId?: string,
) {
  const placed = sites.map((site) => ({ ...site }));
  const overlap = (a: Site, b: Site) => {
    const first = bounds[a.id];
    const second = bounds[b.id];
    return {
      x: Math.min(
        a.x + first.right - b.x - second.left + SITE_GAP,
        b.x + second.right - a.x - first.left + SITE_GAP,
      ),
      y: Math.min(
        a.y + first.bottom - b.y - second.top + SITE_GAP,
        b.y + second.bottom - a.y - first.top + SITE_GAP,
      ),
    };
  };
  // Include labels and halos, and keep the domain being manipulated pinned.
  for (let pass = 0; pass < 100; pass += 1) {
    let moved = false;
    for (let first = 0; first < placed.length; first += 1) {
      for (let second = first + 1; second < placed.length; second += 1) {
        const a = placed[first];
        const b = placed[second];
        const collision = overlap(a, b);
        if (collision.x <= 0 || collision.y <= 0) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        const nx = distance > 0 ? dx / distance : 1;
        const ny = distance > 0 ? dy / distance : 0;
        const shift =
          Math.min(
            Math.abs(nx) > 0 ? collision.x / Math.abs(nx) : Infinity,
            Math.abs(ny) > 0 ? collision.y / Math.abs(ny) : Infinity,
          ) + 0.1;
        const aShare = a.id === anchorId ? 0 : b.id === anchorId ? 1 : 0.5;
        a.x -= nx * shift * aShare;
        a.y -= ny * shift * aShare;
        b.x += nx * shift * (1 - aShare);
        b.y += ny * shift * (1 - aShare);
        moved = true;
      }
    }
    if (!moved) return placed;
  }
  // A crowded layout must still terminate with enough room for every domain.
  const settled: Site[] = [];
  const anchor = placed.find((site) => site.id === anchorId);
  if (anchor) settled.push(anchor);
  for (const site of placed) {
    if (site === anchor) continue;
    if (
      settled.some((other) => {
        const collision = overlap(site, other);
        return collision.x > 0 && collision.y > 0;
      })
    ) {
      site.x =
        Math.max(...settled.map((other) => other.x + bounds[other.id].right)) +
        SITE_GAP -
        bounds[site.id].left +
        0.1;
    }
    settled.push(site);
  }
  return placed;
}

export default function Graph({
  sites: inputSites,
  links,
  selection,
  onSelect,
  expanded,
  focusedExpanded,
  onAutoExpandedChange,
  onFocusSite,
  onExpandedChange,
  running,
  resetKey,
  connectionStyle,
}: Props) {
  const {
    pages: allPages,
    aggregateConnections,
    pageUrl,
    live,
  } = useGraphData();
  const pageCounts = new Map<string, number>();
  const pages = live
    ? allPages.filter((page) => {
        const count = pageCounts.get(page.siteId) ?? 0;
        pageCounts.set(page.siteId, count + 1);
        return count < 60;
      })
    : allPages;
  const renderedPageIds = new Set(pages.map((page) => page.id));
  const markerId = (id: string) =>
    live
      ? `arrow-${Array.from(id)
          .map((character) => character.charCodeAt(0).toString(16))
          .join('-')}`
      : `arrow-${id}`;
  const [touchTargets, setTouchTargets] = useState(
    () => window.matchMedia('(pointer: coarse)').matches,
  );
  const rowGap = touchTargets ? 52 : 43;
  const pageLayout = (site: Site, compact: boolean) =>
    calculatePageLayout(site, compact, pages, rowGap);
  const pagePosition = (page: Page, site: Site, compact: boolean) =>
    calculatePagePosition(page, site, compact, pages, rowGap);
  const svgRef = useRef<SVGSVGElement>(null);
  const [compact, setCompact] = useState(() => window.innerWidth <= 760);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [dragFrame, setDragFrame] = useState<string | null>(null);
  const dragging = dragFrame !== null;
  const [siteBounds, setSiteBounds] = useState<Record<string, SiteBounds>>({});
  const measuredBounds = useRef<{
    key: string;
    bounds: Record<string, SiteBounds>;
  } | null>(null);
  const [fontRevision, setFontRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) setFontRevision((value) => value + 1);
    });
    return () => {
      active = false;
    };
  }, []);
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const drag = useRef<{
    x: number;
    y: number;
    pointerId: number;
    siteId?: string;
  } | null>(null);
  const dragged = useRef(false);
  const suppressClick = useRef(false);
  const autoExpanded = camera.zoom >= 1.65;
  useEffect(() => {
    onAutoExpandedChange(autoExpanded);
    return () => onAutoExpandedChange(false);
  }, [autoExpanded, onAutoExpandedChange]);
  const isExpanded = (id: string) => expanded.includes(id);
  const connections = aggregateConnections(links);
  const denseSite = inputSites.find(
    (site) =>
      focusedExpanded.includes(site.id) &&
      pages.filter((page) => page.siteId === site.id).length > 6,
  );
  const centerX = compact ? 300 : 500;
  const centerY = compact ? 410 : 380;
  const mobilePositions: Record<string, [number, number]> = {
    atlas: [300, 350],
    journal: [140, 135],
    objects: [460, 135],
    collective: [140, 565],
    index: [460, 565],
    archive: [300, 710],
  };
  const layoutSites = inputSites.map((site) =>
    compact
      ? {
          ...site,
          x: mobilePositions[site.id]?.[0] ?? site.x * 0.6,
          y: mobilePositions[site.id]?.[1] ?? site.y,
        }
      : site,
  );
  const automaticLayout = useRef(true);
  const previousLayout = useRef<{
    compact: boolean;
    resetKey: number;
    expanded: string[];
    visibleIds: string[];
    boundsKey: string;
    bases: Record<string, { x: number; y: number }>;
  } | null>(null);
  useLayoutEffect(() => {
    const nodes = Array.from(
      svgRef.current?.querySelectorAll<SVGGElement>('.site-node') ?? [],
    );
    const measurementKey = JSON.stringify([
      compact,
      touchTargets,
      fontRevision,
      nodes.map((node) => [
        node.querySelector('[data-drag-site]')?.getAttribute('data-drag-site'),
        node.querySelector('[data-drag-site] circle')?.getAttribute('r'),
        node.textContent,
      ]),
    ]);
    // SVG text bounds can vary slightly with zoom. Only remeasure changed content.
    if (measuredBounds.current?.key !== measurementKey) {
      const bounds: Record<string, SiteBounds> = {};
      for (const node of nodes) {
        const hit = node.querySelector('[data-drag-site]')!;
        const circle = hit.querySelector('circle')!;
        const id = hit.getAttribute('data-drag-site')!;
        const x = Number(circle.getAttribute('cx'));
        const y = Number(circle.getAttribute('cy'));
        const radius = Number(circle.getAttribute('r'));
        const box = node.getBBox();
        const domainWidth =
          node
            .querySelector<SVGTextElement>('.node-domain')
            ?.getComputedTextLength() ?? 0;
        bounds[id] = {
          domainWidth,
          left: Math.floor(Math.min(box.x - x, -radius - 10) + 0.001),
          top: Math.floor(Math.min(box.y - y, -radius - 10) + 0.001),
          right: Math.ceil(
            Math.max(
              box.x + box.width - x,
              radius + 10,
              domainWidth / 2 + (touchTargets ? 50 : 32),
            ) - 0.001,
          ),
          bottom: Math.ceil(
            Math.max(box.y + box.height - y, radius + 10) - 0.001,
          ),
        };
      }
      measuredBounds.current = { key: measurementKey, bounds };
    }
    const measured = measuredBounds.current.bounds;
    const boundsKey = JSON.stringify(measured);
    setSiteBounds((current) =>
      JSON.stringify(current) === boundsKey ? current : measured,
    );
    const previous = previousLayout.current;
    const reset =
      previous !== null &&
      (previous.compact !== compact || previous.resetKey !== resetKey);
    if (reset || previous === null) automaticLayout.current = true;
    if (focusedExpanded.length > 0) automaticLayout.current = false;
    const automatic = automaticLayout.current;
    const balanced = live && automatic;
    const shiftedBase =
      live &&
      !reset &&
      layoutSites.some((site) => {
        const base = previous?.bases[site.id];
        return base && (base.x !== site.x || base.y !== site.y);
      });
    const added = expanded.filter((id) => !previous?.expanded.includes(id));
    const newVisibleSite = inputSites.some(
      (site) => !previous?.visibleIds.includes(site.id),
    );
    const resized = previous?.boundsKey !== boundsKey;
    previousLayout.current = {
      compact,
      resetKey,
      expanded,
      visibleIds: inputSites.map((site) => site.id),
      boundsKey,
      bases: Object.fromEntries(
        layoutSites.map((site) => [site.id, { x: site.x, y: site.y }]),
      ),
    };
    if (
      !reset &&
      added.length === 0 &&
      !newVisibleSite &&
      !resized &&
      !shiftedBase
    )
      return;
    const anchorId = [...added, ...focusedExpanded].find((id) =>
      inputSites.some((site) => site.id === id),
    );
    setPositions((current) => {
      const offsets = reset ? {} : { ...current };
      if (shiftedBase) {
        // Preserve manual placement when a known target becomes a scanned origin.
        for (const site of layoutSites) {
          const base = previous?.bases[site.id];
          if (base)
            offsets[site.id] = {
              x: (current[site.id]?.x ?? 0) + base.x - site.x,
              y: (current[site.id]?.y ?? 0) + base.y - site.y,
            };
        }
      }
      const positioned = layoutSites.map((site) => ({
        ...site,
        x: site.x + (offsets[site.id]?.x ?? 0),
        y: site.y + (offsets[site.id]?.y ?? 0),
      }));
      // Rebuild untouched layouts from their bases when font metrics change.
      const initial = balanced
        ? balanceSites(layoutSites, measured)
        : automatic
          ? layoutSites
          : positioned;
      const placed = separateSites(initial, measured, anchorId);
      return {
        ...offsets,
        ...Object.fromEntries(
          placed.map((site, index) => [
            site.id,
            {
              x: site.x - layoutSites[index].x,
              y: site.y - layoutSites[index].y,
            },
          ]),
        ),
      };
    });
  }, [
    compact,
    touchTargets,
    resetKey,
    expanded,
    focusedExpanded,
    inputSites,
    pages,
    fontRevision,
    live,
  ]);

  const sites = layoutSites.map((site) => ({
    ...site,
    x: site.x + (positions[site.id]?.x ?? 0),
    y: site.y + (positions[site.id]?.y ?? 0),
  }));
  const boundsFor = (site: Site): SiteBounds =>
    siteBounds[site.id] ?? {
      left: -site.radius - 10,
      top: -site.radius - 10,
      right: site.radius + 10,
      bottom: site.radius + 35,
    };
  const minX = Math.min(
    0,
    ...sites.map((site) => site.x + boundsFor(site).left - 25),
  );
  const minY = Math.min(
    0,
    ...sites.map((site) => site.y + boundsFor(site).top - 25),
  );
  const maxX = Math.max(
    compact ? 600 : 1000,
    ...sites.map((site) => site.x + boundsFor(site).right + 25),
  );
  const maxY = Math.max(
    compact ? 820 : 760,
    ...sites.map((site) => site.y + boundsFor(site).bottom + 50),
  );

  const moveSite = (id: string, dx: number, dy: number) => {
    automaticLayout.current = false;
    setPositions((previous) => {
      const positioned = layoutSites.map((site) => ({
        ...site,
        x: site.x + (previous[site.id]?.x ?? 0) + (site.id === id ? dx : 0),
        y: site.y + (previous[site.id]?.y ?? 0) + (site.id === id ? dy : 0),
      }));
      const placed = separateSites(positioned, siteBounds, id);
      return {
        ...previous,
        ...Object.fromEntries(
          placed.map((site, index) => [
            site.id,
            {
              x: site.x - layoutSites[index].x,
              y: site.y - layoutSites[index].y,
            },
          ]),
        ),
      };
    });
  };

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const touchQuery = window.matchMedia('(pointer: coarse)');
    const update = () => {
      setCompact(query.matches);
      setTouchTargets(touchQuery.matches);
    };
    query.addEventListener('change', update);
    touchQuery.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
      touchQuery.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    setCamera({ x: 0, y: 0, zoom: 1 });
  }, [resetKey, compact]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        matrix.inverse(),
      );
      setCamera((previous) => {
        const zoom = Math.min(
          2.8,
          Math.max(0.6, previous.zoom * Math.exp(-event.deltaY * 0.002)),
        );
        const ratio = zoom / previous.zoom;
        return {
          zoom,
          x: point.x - centerX - (point.x - centerX - previous.x) * ratio,
          y: point.y - centerY - (point.y - centerY - previous.y) * ratio,
        };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [centerX, centerY]);

  const zoomBy = (factor: number) =>
    setCamera((previous) => ({
      ...previous,
      zoom: Math.min(2.8, Math.max(0.6, previous.zoom * factor)),
    }));
  const reset = () => {
    previousLayout.current = null;
    setPositions({});
    setCamera({ x: 0, y: 0, zoom: 1 });
    onExpandedChange([]);
  };
  const pointFromEvent = (event: PointerEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM();
    return matrix
      ? new DOMPoint(event.clientX, event.clientY).matrixTransform(
          matrix.inverse(),
        )
      : null;
  };
  const startDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || drag.current) return;
    dragged.current = false;
    suppressClick.current = false;
    const target = event.target as Element;
    const siteId =
      target.closest('[data-drag-site]')?.getAttribute('data-drag-site') ??
      undefined;
    if (!siteId && target.closest('[data-interactive]')) return;
    const point = pointFromEvent(event);
    if (!point) return;
    drag.current = {
      x: point.x,
      y: point.y,
      pointerId: event.pointerId,
      siteId,
    };
  };
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const dx = point.x - current.x;
    const dy = point.y - current.y;
    if (!dragged.current && Math.hypot(dx, dy) < 4) return;
    if (!dragged.current) {
      event.currentTarget.setPointerCapture(event.pointerId);
      // Keep screen-to-map coordinates stable until the gesture finishes.
      setDragFrame(event.currentTarget.getAttribute('viewBox'));
    }
    dragged.current = true;
    if (current.siteId)
      moveSite(current.siteId, dx / camera.zoom, dy / camera.zoom);
    else
      setCamera((previous) => ({
        ...previous,
        x: previous.x + dx,
        y: previous.y + dy,
      }));
    drag.current = { ...current, x: point.x, y: point.y };
  };
  const stopDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    suppressClick.current = dragged.current && event.type === 'pointerup';
    dragged.current = false;
    drag.current = null;
    setDragFrame(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className={`graph-area ${running ? 'is-running' : ''} ${denseSite ? 'has-dense-site' : ''}`}
    >
      <div className="map-caption">
        <span className="tiny-cross">+</span>{' '}
        {live ? 'LOKÁLNÍ SKEN' : 'STUDIO ATLAS'} <span>/</span> EKOSYSTÉM WEBŮ
      </div>
      {!live && (
        <button
          className="dense-demo-button"
          onClick={() => {
            onSelect({ type: 'site', id: 'index' });
            onFocusSite('index');
          }}
        >
          <Layers2 size={13} />
          Ukázka: 20 stránek
        </button>
      )}
      <svg
        ref={svgRef}
        className={`graph ${dragging ? 'is-dragging' : ''}`}
        viewBox={dragFrame ?? `${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        aria-label="Interaktivní mapa odkazů mezi weby"
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.stopPropagation();
            suppressClick.current = false;
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' || event.key === ' ')
            suppressClick.current = false;
        }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget) stopDrag(event);
        }}
      >
        <defs>
          {sites.map((site) => (
            <marker
              key={site.id}
              id={markerId(site.id)}
              viewBox="-15 -8 17 16"
              refX="0"
              refY="0"
              markerUnits="userSpaceOnUse"
              markerWidth="17"
              markerHeight="16"
              orient="auto-start-reverse"
            >
              <ArrowHead color={site.color} />
            </marker>
          ))}
        </defs>
        <g
          transform={`translate(${centerX + camera.x} ${centerY + camera.y}) scale(${camera.zoom}) translate(${-centerX} ${-centerY})`}
          data-testid="graph-camera"
        >
          {sites.map((site) => {
            const open = isExpanded(site.id);
            const selected =
              selection?.type === 'site' && selection.id === site.id;
            const radius = open
              ? pageLayout(site, compact).radius
              : site.radius;
            return (
              <g key={site.id} aria-hidden="true" pointerEvents="none">
                <circle
                  cx={site.x}
                  cy={site.y}
                  r={radius + 10}
                  fill="none"
                  stroke={site.color}
                  strokeWidth="1"
                  opacity={selected ? 0.26 : 0.08}
                  strokeDasharray={site.scanned ? '3 5' : '4 5'}
                />
                <circle
                  className="cluster-fill"
                  data-site={site.id}
                  cx={site.x}
                  cy={site.y}
                  r={radius}
                  fill={site.tint}
                  fillOpacity={open ? 0.87 : 0.95}
                  stroke={site.color}
                  strokeOpacity={selected ? 0.75 : 0.23}
                  strokeWidth={selected ? 1.6 : 1}
                  strokeDasharray={site.scanned ? undefined : '5 5'}
                />
              </g>
            );
          })}
          {connections.map((connection) => {
            if (
              denseSite &&
              connection.source.id !== denseSite.id &&
              connection.target.id !== denseSite.id
            )
              return null;
            const source = sites.find(
              (site) => site.id === connection.source.id,
            )!;
            const target = sites.find(
              (site) => site.id === connection.target.id,
            )!;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const length = Math.max(1, Math.hypot(dx, dy));
            const normal = { x: -dy / length, y: dx / length };
            const selected =
              selection?.type === 'connection' &&
              selection.id === connection.id;
            const related =
              selection?.type === 'site' &&
              (selection.id === source.id || selection.id === target.id);
            const showPages = isExpanded(source.id) || isExpanded(target.id);
            const sourceRadius = isExpanded(source.id)
              ? pageLayout(source, compact).radius
              : source.radius;
            const targetRadius = isExpanded(target.id)
              ? pageLayout(target, compact).radius
              : target.radius;
            const from = {
              x: source.x + (dx / length) * (sourceRadius + 9),
              y: source.y + (dy / length) * (sourceRadius + 9),
            };
            const to = {
              x: target.x - (dx / length) * (targetRadius + 11),
              y: target.y - (dy / length) * (targetRadius + 11),
            };
            const obstacles = sites.filter(
              (site) => site.id !== source.id && site.id !== target.id,
            );
            const bends = [38, -38, 180, -180, 320, -320, 460, -460];
            const bend =
              bends.find((offset) =>
                obstacles.every((site) => {
                  const radius = isExpanded(site.id)
                    ? pageLayout(site, compact).radius
                    : site.radius;
                  return Array.from(
                    { length: 19 },
                    (_, index) => (index + 1) / 20,
                  ).every((t) => {
                    const x =
                      (1 - t) ** 2 * from.x +
                      2 *
                        (1 - t) *
                        t *
                        ((from.x + to.x) / 2 + normal.x * offset) +
                      t ** 2 * to.x;
                    const y =
                      (1 - t) ** 2 * from.y +
                      2 *
                        (1 - t) *
                        t *
                        ((from.y + to.y) / 2 + normal.y * offset) +
                      t ** 2 * to.y;
                    return Math.hypot(x - site.x, y - site.y) > radius + 22;
                  });
                }),
              ) ?? 38;
            const control = {
              x: (from.x + to.x) / 2 + normal.x * bend,
              y: (from.y + to.y) / 2 + normal.y * bend,
            };
            const countLabel = isFineConnectionStyle(connectionStyle)
              ? connectionStrengthLabel(connection.links.length)
              : connection.links.length > 5
                ? '5+'
                : String(connection.links.length);
            const labelWidth = countLabel.length > 2 ? 38 : 24;
            const curve = `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`;
            const label = {
              x: (from.x + 2 * control.x + to.x) / 4,
              y: (from.y + 2 * control.y + to.y) / 4,
            };
            return (
              <g
                key={connection.id}
                data-connection={connection.id}
                className={`connection ${selected || related ? 'is-related' : ''}`}
              >
                {showPages ? (
                  connection.links
                    .filter(
                      (link) =>
                        (!isExpanded(source.id) ||
                          renderedPageIds.has(link.source.id)) &&
                        (!isExpanded(target.id) ||
                          renderedPageIds.has(link.target.id)),
                    )
                    .slice(0, live ? 200 : undefined)
                    .map((link) => {
                      const a = isExpanded(source.id)
                        ? pagePosition(link.source, source, compact)
                        : from;
                      const b = isExpanded(target.id)
                        ? pagePosition(link.target, target, compact)
                        : to;
                      const path = pageLinkPath(
                        a,
                        {
                          x: (a.x + b.x) / 2 + normal.x * 22,
                          y: (a.y + b.y) / 2 + normal.y * 22,
                        },
                        b,
                        isExpanded(target.id),
                      );
                      const active =
                        (selection?.type === 'link' &&
                          selection.id === link.id) ||
                        (selection?.type === 'page' &&
                          (selection.id === link.source.id ||
                            selection.id === link.target.id));
                      return (
                        <g
                          key={link.id}
                          data-interactive="true"
                          role="button"
                          tabIndex={0}
                          aria-label={`Odkaz ${source.domain}${link.source.path} → ${target.domain}${link.target.path}`}
                          onClick={() =>
                            onSelect({ type: 'link', id: link.id })
                          }
                          onKeyDown={(event) =>
                            activate(event, () =>
                              onSelect({ type: 'link', id: link.id }),
                            )
                          }
                          className="page-edge"
                        >
                          <path
                            d={path}
                            stroke={source.color}
                            strokeWidth={active ? 2.8 : 1.1}
                            opacity={
                              active
                                ? 1
                                : selection?.type === 'page' ||
                                    selection?.type === 'link'
                                  ? 0.06
                                  : denseSite
                                    ? 0.18
                                    : 0.34
                            }
                            fill="none"
                            markerEnd={`url(#${markerId(source.id)})`}
                          />
                          <path
                            d={path}
                            stroke="transparent"
                            strokeWidth="12"
                            fill="none"
                          />
                        </g>
                      );
                    })
                ) : (
                  <g
                    data-interactive="true"
                    role="button"
                    tabIndex={0}
                    aria-label={`Propojení ${source.domain} → ${target.domain}, ${connection.links.length} vazeb`}
                    onClick={() =>
                      onSelect({ type: 'connection', id: connection.id })
                    }
                    onKeyDown={(event) =>
                      activate(event, () =>
                        onSelect({ type: 'connection', id: connection.id }),
                      )
                    }
                  >
                    <ConnectionStroke
                      variant={connectionStyle}
                      from={from}
                      to={to}
                      control={control}
                      color={source.color}
                      count={connection.links.length}
                      selected={selected || related}
                      markerId={markerId(source.id)}
                    />
                    {running && (
                      <path
                        className="connection-flow"
                        d={curve}
                        fill="none"
                        stroke={source.color}
                        strokeWidth={1.2}
                        opacity={0.85}
                        pointerEvents="none"
                        aria-hidden="true"
                      />
                    )}
                    <path
                      d={curve}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="12"
                    />
                    <rect
                      x={label.x - labelWidth / 2}
                      y={label.y - 10}
                      width={labelWidth}
                      height="20"
                      rx="7"
                      fill="var(--surface, #fcfdf9)"
                      stroke={selected ? source.color : 'var(--line, #e1e6dc)'}
                    />
                    <text
                      x={label.x}
                      y={label.y + 4}
                      textAnchor="middle"
                      className="edge-count"
                      fill={source.color}
                    >
                      {countLabel}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {sites.map((site) => {
            const open = isExpanded(site.id);
            const selected =
              selection?.type === 'site' && selection.id === site.id;
            const sitePages = pages.filter((page) => page.siteId === site.id);
            const knownSitePages = allPages.filter(
              (page) => page.siteId === site.id,
            );
            const knownPageCount = knownSitePages.length;
            const radius = open
              ? pageLayout(site, compact).radius
              : site.radius;
            const select = () => onSelect({ type: 'site', id: site.id });
            const toggle = () =>
              onExpandedChange(
                expanded.includes(site.id)
                  ? expanded.filter((id) => id !== site.id)
                  : [...expanded, site.id],
              );
            return (
              <g
                key={site.id}
                className={`site-node ${selected ? 'is-selected' : ''} ${open ? 'is-expanded' : ''}`}
              >
                {!open &&
                  sitePages.slice(0, 24).map((page, index) => {
                    const angle =
                      (index / Math.min(sitePages.length, 24)) * Math.PI * 2 +
                      0.3;
                    const distance = radius * 0.71;
                    return (
                      <circle
                        key={page.id}
                        className="page-summary-dot"
                        cx={site.x + Math.cos(angle) * distance}
                        cy={site.y + Math.sin(angle) * distance}
                        r={index === 0 ? 4 : 2.7}
                        fill={site.color}
                        opacity={0.25 + (index % 3) * 0.12}
                      />
                    );
                  })}
                <g
                  data-interactive="true"
                  role="button"
                  tabIndex={0}
                  aria-label={`Doména ${site.domain}`}
                  aria-pressed={selected}
                  onClick={select}
                  onDoubleClick={toggle}
                  onKeyDown={(event) => {
                    const direction: Record<string, [number, number]> = {
                      ArrowLeft: [-1, 0],
                      ArrowRight: [1, 0],
                      ArrowUp: [0, -1],
                      ArrowDown: [0, 1],
                    };
                    if (direction[event.key]) {
                      event.preventDefault();
                      const [dx, dy] = direction[event.key];
                      const step = event.shiftKey ? 50 : 15;
                      moveSite(site.id, dx * step, dy * step);
                    } else activate(event, select);
                  }}
                  className="site-hit"
                  data-drag-site={site.id}
                >
                  <circle
                    cx={site.x}
                    cy={site.y}
                    r={radius}
                    fill="transparent"
                  />
                  {!open && (
                    <>
                      <rect
                        x={site.x - 17}
                        y={site.y - 36}
                        width="34"
                        height="34"
                        rx="11"
                        fill={site.color}
                      />
                      <text
                        x={site.x}
                        y={site.y - 13}
                        textAnchor="middle"
                        fill="var(--badge-ink, white)"
                        className="node-initial"
                      >
                        {site.name === 'Studio Atlas'
                          ? 'a'
                          : site.domain.charAt(0)}
                      </text>
                      <text
                        x={site.x}
                        y={site.y + 21}
                        textAnchor="middle"
                        className="node-domain"
                        fill="var(--ink, #293d33)"
                      >
                        {site.domain}
                      </text>
                      <text
                        x={site.x}
                        y={site.y + 40}
                        textAnchor="middle"
                        className="node-meta"
                      >
                        {live
                          ? `${knownSitePages.filter((page) => page.status === 'ok').length} načteno · ${knownPageCount} URL`
                          : site.scanned
                            ? `${sitePages.length} stránek`
                            : 'neprozkoumáno'}
                      </text>
                    </>
                  )}
                  {open && (
                    <text
                      x={site.x}
                      y={site.y - radius + 35}
                      textAnchor="middle"
                      className="node-domain"
                      fill={site.color}
                    >
                      {site.domain}
                    </text>
                  )}
                  {open && sitePages.length > 6 && (
                    <text
                      x={site.x}
                      y={site.y - radius + 57}
                      textAnchor="middle"
                      className="node-meta"
                    >
                      {sitePages.length}
                      {live && knownPageCount > sitePages.length
                        ? ` z ${knownPageCount}`
                        : ''}{' '}
                      {live ? 'URL' : 'stránek'} · vyberte stránku a sledujte
                      její vazby
                    </text>
                  )}
                </g>
                <GraphExternalLink
                  url={siteUrl(site)}
                  x={
                    site.x +
                    (boundsFor(site).domainWidth ?? site.domain.length * 7) /
                      2 +
                    (touchTargets ? 15 : 6)
                  }
                  y={open ? site.y - radius + 19 : site.y + 5}
                  touch={touchTargets}
                />
                {open &&
                  sitePages.map((page) => {
                    const position = pagePosition(page, site, compact);
                    const active =
                      selection?.type === 'page' && selection.id === page.id;
                    const action = () =>
                      onSelect({ type: 'page', id: page.id });
                    return (
                      <g key={page.id}>
                        <g
                          data-interactive="true"
                          role="button"
                          tabIndex={0}
                          aria-label={`Stránka ${site.domain}${page.path}`}
                          aria-pressed={active}
                          className="page-node"
                          data-page-status={page.status}
                          onClick={action}
                          onKeyDown={(event) => activate(event, action)}
                        >
                          {live && (
                            <title>
                              {page.url} · {pageStatusLabel(page)}
                            </title>
                          )}
                          <rect
                            x={position.x + PAGE_CARD.x}
                            y={position.y + PAGE_CARD.y}
                            width={PAGE_CARD.width}
                            height={PAGE_CARD.height}
                            rx="8"
                            fill={
                              active ? site.color : 'var(--surface, #ffffff)'
                            }
                            stroke={site.color}
                            strokeOpacity={active ? 1 : 0.23}
                            strokeDasharray={
                              page.status && page.status !== 'ok'
                                ? '3 2'
                                : undefined
                            }
                          />
                          <circle
                            cx={position.x - 4}
                            cy={position.y + 1}
                            r="3"
                            fill={
                              active ? 'var(--badge-ink, #fff)' : site.color
                            }
                          />
                          <text
                            x={position.x + 5}
                            y={position.y + 5}
                            fill={
                              active
                                ? 'var(--badge-ink, #fff)'
                                : 'var(--ink, #3c4a41)'
                            }
                            className="page-label"
                          >
                            {page.path.length > 13
                              ? `${page.path.slice(0, 12)}…`
                              : page.path}
                          </text>
                        </g>
                        <GraphExternalLink
                          url={pageUrl(page)}
                          x={position.x + (touchTargets ? 93 : 95)}
                          y={position.y - 13}
                          touch={touchTargets}
                        />
                      </g>
                    );
                  })}
                <text
                  x={site.x}
                  y={site.y + radius + 30}
                  textAnchor="middle"
                  className="cluster-category"
                >
                  {site.category}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map-bottom">
        <div className="map-legend">
          <span>
            <i className="legend-dot" />{' '}
            {live ? 'Povolený origin' : 'Prozkoumaný web'}
          </span>
          <span>
            <i className="legend-line" /> Směr odkazu
          </span>
        </div>
        <div className="map-controls">
          <button
            className="icon-button"
            aria-label="Oddálit mapu"
            onClick={() => zoomBy(1 / 1.2)}
            disabled={camera.zoom <= 0.6}
          >
            <Minus size={16} />
          </button>
          <output aria-label="Přiblížení mapy">
            {Math.round(camera.zoom * 100)} %
          </output>
          <button
            className="icon-button"
            aria-label="Přiblížit mapu"
            onClick={() => zoomBy(1.2)}
            disabled={camera.zoom >= 2.8}
          >
            <Plus size={16} />
          </button>
          <span className="control-divider" />
          <button
            className="icon-button"
            aria-label="Zobrazit celou mapu"
            onClick={reset}
          >
            <Expand size={16} />
          </button>
        </div>
      </div>
      <div className="map-hint">
        <MousePointer2 size={12} />{' '}
        {denseSite
          ? `Zobrazeny vazby ${denseSite.domain}. Kliknutím vyberete stránku.`
          : `Táhněte domény od sebe. Síla vazeb: ${isFineConnectionStyle(connectionStyle) ? '1–100+' : '1–5+'}. Přesné počty v detailu.`}{' '}
        <button onClick={reset} aria-label="Obnovit pohled">
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
}
