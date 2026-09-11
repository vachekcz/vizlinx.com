import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Expand, Minus, MousePointer2, Plus, RotateCcw } from 'lucide-react';
import { aggregateConnections, getSite, pages } from './data';
import type { Link, Page, Selection, Site } from './data';

type Props = {
  sites: Site[];
  links: Link[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  expanded: string[];
  onExpandedChange: (ids: string[]) => void;
  running: boolean;
  resetKey: number;
};

function activate(event: KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

function pagePosition(page: Page, site = getSite(page.siteId)) {
  const index = pages
    .filter((item) => item.siteId === site.id)
    .findIndex((item) => item.id === page.id);
  return {
    x: site.x - 90 + (index % 2) * 112,
    y: site.y - 36 + Math.floor(index / 2) * 43,
  };
}

export default function Graph({
  sites: inputSites,
  links,
  selection,
  onSelect,
  expanded,
  onExpandedChange,
  running,
  resetKey,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [compact, setCompact] = useState(() => window.innerWidth <= 760);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const autoExpanded = camera.zoom >= 1.65;
  const isExpanded = (id: string) => expanded.includes(id) || autoExpanded;
  const connections = aggregateConnections(links);
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
  const sites = inputSites.map((site) =>
    compact
      ? {
          ...site,
          x: mobilePositions[site.id][0],
          y: mobilePositions[site.id][1],
        }
      : site,
  );

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
    if (
      event.button !== 0 ||
      (event.target as Element).closest('[data-interactive]')
    )
      return;
    const point = pointFromEvent(event);
    if (!point) return;
    drag.current = point;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const dx = point.x - drag.current.x;
    const dy = point.y - drag.current.y;
    setCamera((previous) => ({
      ...previous,
      x: previous.x + dx,
      y: previous.y + dy,
    }));
    drag.current = point;
  };
  const stopDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className={`graph-area ${running ? 'is-running' : ''}`}>
      <div className="map-caption">
        <span className="tiny-cross">+</span> STUDIO ATLAS <span>/</span>{' '}
        EKOSYSTÉM WEBŮ
      </div>
      <svg
        ref={svgRef}
        className={`graph ${dragging ? 'is-dragging' : ''}`}
        viewBox={compact ? '0 0 600 820' : '0 0 1000 760'}
        aria-label="Interaktivní mapa odkazů mezi weby"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag}
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
          {connections.map((connection) => {
            const source = sites.find(
              (site) => site.id === connection.source.id,
            )!;
            const target = sites.find(
              (site) => site.id === connection.target.id,
            )!;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const length = Math.hypot(dx, dy);
            const normal = { x: -dy / length, y: dx / length };
            const selected =
              selection?.type === 'connection' &&
              selection.id === connection.id;
            const related =
              selection?.type === 'site' &&
              (selection.id === source.id || selection.id === target.id);
            const showPages = isExpanded(source.id) || isExpanded(target.id);
            const sourceRadius = isExpanded(source.id) ? 122 : source.radius;
            const targetRadius = isExpanded(target.id) ? 122 : target.radius;
            const from = {
              x: source.x + (dx / length) * (sourceRadius + 9),
              y: source.y + (dy / length) * (sourceRadius + 9),
            };
            const to = {
              x: target.x - (dx / length) * (targetRadius + 11),
              y: target.y - (dy / length) * (targetRadius + 11),
            };
            const control = {
              x: (from.x + to.x) / 2 + normal.x * 38,
              y: (from.y + to.y) / 2 + normal.y * 38,
            };
            const curve = `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`;
            const label = {
              x: (from.x + 2 * control.x + to.x) / 4,
              y: (from.y + 2 * control.y + to.y) / 4,
            };
            return (
              <g
                key={connection.id}
                className={`connection ${selected || related ? 'is-related' : ''}`}
              >
                {showPages ? (
                  connection.links.map((link) => {
                    const a = isExpanded(source.id)
                      ? pagePosition(link.source, source)
                      : from;
                    const b = isExpanded(target.id)
                      ? pagePosition(link.target, target)
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
                          opacity={active ? 1 : 0.34}
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
                    <path
                      className="connection-line"
                      d={curve}
                      fill="none"
                      stroke={source.color}
                      strokeWidth={
                        selected ? 3.5 : 1 + connection.links.length * 0.3
                      }
                      markerEnd={`url(#arrow-${source.id})`}
                    />
                    <path
                      d={curve}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="22"
                    />
                    <rect
                      x={label.x - 12}
                      y={label.y - 10}
                      width="24"
                      height="20"
                      rx="7"
                      fill="#fcfdf9"
                      stroke={selected ? source.color : '#e1e6dc'}
                    />
                    <text
                      x={label.x}
                      y={label.y + 4}
                      textAnchor="middle"
                      className="edge-count"
                      fill={source.color}
                    >
                      {connection.links.length}
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
            const radius = open ? 122 : site.radius;
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
                  onKeyDown={(event) => activate(event, select)}
                  className="site-hit"
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
                        fill="white"
                        className="node-initial"
                      >
                        {site.name === 'Studio Atlas' ? 'a' : site.id.charAt(0)}
                      </text>
                      <text
                        x={site.x}
                        y={site.y + 21}
                        textAnchor="middle"
                        className="node-domain"
                        fill="#293d33"
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
                      y={site.y - 90}
                      textAnchor="middle"
                      className="node-domain"
                      fill={site.color}
                    >
                      {site.domain}
                    </text>
                  )}
                </g>
                {open &&
                  sitePages.map((page) => {
                    const position = pagePosition(page, site);
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
                          fill={active ? site.color : '#ffffff'}
                          stroke={site.color}
                          strokeOpacity={active ? 1 : 0.23}
                        />
                        <circle
                          cx={position.x - 4}
                          cy={position.y + 1}
                          r="3"
                          fill={active ? '#fff' : site.color}
                        />
                        <text
                          x={position.x + 5}
                          y={position.y + 5}
                          fill={active ? '#fff' : '#3c4a41'}
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
        <MousePointer2 size={12} /> Tažením posunete mapu. Dvojklik rozbalí
        stránky.{' '}
        <button onClick={reset} aria-label="Obnovit pohled">
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
}
