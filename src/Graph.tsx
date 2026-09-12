import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import {
  Expand,
  Layers2,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { aggregateConnections, pages } from './data';
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

function activate(event: KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

function pageLayout(site: Site, compact: boolean) {
  const count = pages.filter((page) => page.siteId === site.id).length;
  const columns = count > 6 ? (compact ? 3 : 4) : 2;
  const rows = Math.ceil(count / columns);
  const width = columns * 112 - 6;
  const radius = Math.max(
    122,
    Math.ceil(Math.hypot(width / 2, ((rows - 1) * 43) / 2 + 15) + 25),
  );
  return { columns, rows, width, radius };
}

function pagePosition(page: Page, site: Site, compact: boolean) {
  const index = pages
    .filter((item) => item.siteId === site.id)
    .findIndex((item) => item.id === page.id);
  const { columns, rows, width } = pageLayout(site, compact);
  return {
    x: site.x - width / 2 + 15 + (index % columns) * 112,
    y: site.y - ((rows - 1) * 43) / 2 + Math.floor(index / columns) * 43,
  };
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
  const svgRef = useRef<SVGSVGElement>(null);
  const [compact, setCompact] = useState(() => window.innerWidth <= 760);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [dragging, setDragging] = useState(false);
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
  const centerY = compact ? (denseSite ? 500 : 410) : 380;
  const mobilePositions: Record<string, [number, number]> = {
    atlas: [300, 350],
    journal: [140, 135],
    objects: [460, 135],
    collective: [140, 565],
    index: [460, 565],
    archive: [300, 710],
  };
  const layoutSites = inputSites.map((site) =>
    denseSite
      ? (() => {
          if (site.id === denseSite.id)
            return { ...site, x: centerX, y: compact ? 460 : 350 };
          const surrounding = inputSites.filter(
            (item) => item.id !== denseSite.id,
          );
          const positions = compact
            ? [
                [70, 120],
                [530, 120],
                [70, 760],
                [530, 760],
                [300, 880],
              ]
            : [
                [110, 130],
                [890, 130],
                [110, 560],
                [890, 560],
                [930, 350],
              ];
          const [x, y] =
            positions[surrounding.findIndex((item) => item.id === site.id)];
          return {
            ...site,
            x,
            y,
            radius: compact ? Math.min(site.radius, 60) : site.radius,
          };
        })()
      : compact
        ? {
            ...site,
            x: mobilePositions[site.id][0],
            y: mobilePositions[site.id][1],
          }
        : site,
  );

  const framedSites = layoutSites.filter((site) =>
    focusedExpanded.includes(site.id),
  );
  const minX = Math.min(
    0,
    ...framedSites.map(
      (site) => site.x - pageLayout(site, compact).radius - 25,
    ),
  );
  const minY = Math.min(
    0,
    ...framedSites.map(
      (site) => site.y - pageLayout(site, compact).radius - 25,
    ),
  );
  const maxX = Math.max(
    compact ? 600 : 1000,
    ...framedSites.map(
      (site) => site.x + pageLayout(site, compact).radius + 25,
    ),
  );
  const maxY = Math.max(
    compact ? (denseSite ? 1000 : 820) : 760,
    ...framedSites.map(
      (site) => site.y + pageLayout(site, compact).radius + 80,
    ),
  );

  const sites = layoutSites.map((site) => ({
    ...site,
    x: site.x + (positions[site.id]?.x ?? 0),
    y: site.y + (positions[site.id]?.y ?? 0),
  }));
  const layoutKey = `${compact}:${denseSite?.id ?? 'overview'}`;
  useEffect(() => {
    setPositions({});
  }, [resetKey, layoutKey]);

  const moveSite = (id: string, dx: number, dy: number) => {
    setPositions((previous) => ({
      ...previous,
      [id]: { x: (previous[id]?.x ?? 0) + dx, y: (previous[id]?.y ?? 0) + dy },
    }));
  };

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
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
    if (!dragged.current)
      event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = true;
    setDragging(true);
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
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className={`graph-area ${running ? 'is-running' : ''} ${denseSite ? 'has-dense-site' : ''}`}
    >
      <div className="map-caption">
        <span className="tiny-cross">+</span> STUDIO ATLAS <span>/</span>{' '}
        EKOSYSTÉM WEBŮ
      </div>
      <button
        className="dense-demo-button"
        onClick={() => {
          setCamera({ x: 0, y: 0, zoom: 1 });
          onSelect({ type: 'site', id: 'index' });
          onFocusSite('index');
        }}
      >
        <Layers2 size={13} />
        Ukázka: 20 stránek
      </button>
      <svg
        ref={svgRef}
        className={`graph ${dragging ? 'is-dragging' : ''}`}
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
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
              id={`arrow-${site.id}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path
                d="M 1 1 L 8 5 L 1 9"
                fill="none"
                stroke={site.color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
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
                  connection.links.map((link) => {
                    const a = isExpanded(source.id)
                      ? pagePosition(link.source, source, compact)
                      : from;
                    const b = isExpanded(target.id)
                      ? pagePosition(link.target, target, compact)
                      : to;
                    const path = `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2 + normal.x * 22} ${(a.y + b.y) / 2 + normal.y * 22} ${b.x} ${b.y}`;
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
                        onClick={() => onSelect({ type: 'link', id: link.id })}
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
                          markerEnd={`url(#arrow-${source.id})`}
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
                      markerId={`arrow-${source.id}`}
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
                  sitePages.map((page, index) => {
                    const angle =
                      (index / sitePages.length) * Math.PI * 2 + 0.3;
                    const distance = radius * 0.71;
                    return (
                      <circle
                        key={page.id}
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
                        {site.name === 'Studio Atlas' ? 'a' : site.id.charAt(0)}
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
                        {site.scanned
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
                      {sitePages.length} stránek · vyberte stránku a sledujte
                      její vazby
                    </text>
                  )}
                </g>
                {open &&
                  sitePages.map((page) => {
                    const position = pagePosition(page, site, compact);
                    const active =
                      selection?.type === 'page' && selection.id === page.id;
                    const action = () =>
                      onSelect({ type: 'page', id: page.id });
                    return (
                      <g
                        key={page.id}
                        data-interactive="true"
                        role="button"
                        tabIndex={0}
                        aria-label={`Stránka ${site.domain}${page.path}`}
                        aria-pressed={active}
                        className="page-node"
                        onClick={action}
                        onKeyDown={(event) => activate(event, action)}
                      >
                        <rect
                          x={position.x - 15}
                          y={position.y - 14}
                          width="106"
                          height="29"
                          rx="8"
                          fill={active ? site.color : 'var(--surface, #ffffff)'}
                          stroke={site.color}
                          strokeOpacity={active ? 1 : 0.23}
                        />
                        <circle
                          cx={position.x - 4}
                          cy={position.y + 1}
                          r="3"
                          fill={active ? 'var(--badge-ink, #fff)' : site.color}
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
            <i className="legend-dot" /> Prozkoumaný web
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
