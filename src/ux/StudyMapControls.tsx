import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Expand, Minus, Plus, RotateCcw } from 'lucide-react';
import type { GraphControls } from '../Graph';
import './study-map-controls.css';

function ControlButton({
  label,
  description,
  disabled,
  tooltip,
  onTooltipChange,
  onClick,
  children,
}: {
  label: string;
  description: string;
  disabled?: boolean;
  tooltip: string | null;
  onTooltipChange: (label: string | null) => void;
  onClick: () => void;
  children: ReactNode;
}) {
  const tooltipId = useId();
  return (
    <span
      className={`ux-map-control ${tooltip === label ? 'is-tooltip-open' : ''}`}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') onTooltipChange(label);
      }}
      onPointerLeave={(event) => {
        const focused = event.currentTarget.querySelector(
          'button:focus-visible',
        );
        onTooltipChange(focused ? label : null);
      }}
    >
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        aria-describedby={tooltipId}
        disabled={disabled}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible'))
            onTooltipChange(label);
        }}
        onBlur={() => onTooltipChange(null)}
        onClick={() => {
          onTooltipChange(null);
          onClick();
        }}
      >
        {children}
      </button>
      <span id={tooltipId} role="tooltip" className="ux-map-tooltip">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
    </span>
  );
}

export default function StudyMapControls({
  zoom,
  canZoomIn,
  canZoomOut,
  zoomIn,
  zoomOut,
  fitToView,
  onRestoreLayout,
}: GraphControls & { onRestoreLayout: () => void }) {
  const [tooltip, setTooltip] = useState<string | null>(null);
  const tooltipProps = { tooltip, onTooltipChange: setTooltip };
  useEffect(() => {
    if (!tooltip) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTooltip(null);
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [tooltip]);
  return (
    <div
      data-map-obstacle
      className="map-controls ux-map-controls"
      role="group"
      aria-label="Ovládání mapy"
    >
      <ControlButton
        {...tooltipProps}
        label="Oddálit mapu"
        description="Zmenší přiblížení. Otevřené stránky zůstanou."
        disabled={!canZoomOut}
        onClick={zoomOut}
      >
        <Minus size={16} />
      </ControlButton>
      <output aria-label="Přiblížení mapy">{Math.round(zoom * 100)} %</output>
      <ControlButton
        {...tooltipProps}
        label="Přiblížit mapu"
        description="Zvětší přiblížení. Mapu můžeš posouvat tažením."
        disabled={!canZoomIn}
        onClick={zoomIn}
      >
        <Plus size={16} />
      </ControlButton>
      <span className="control-divider" aria-hidden="true" />
      <ControlButton
        {...tooltipProps}
        label="Zobrazit celou mapu"
        description="Ukáže celou mapu mimo panely. Zachová polohy bublin i otevřené stránky."
        onClick={fitToView}
      >
        <Expand size={16} />
      </ControlButton>
      <ControlButton
        {...tooltipProps}
        label="Obnovit rozložení"
        description="Vrátí původní polohy, sbalí stránky a zavře detail."
        onClick={onRestoreLayout}
      >
        <RotateCcw size={15} />
      </ControlButton>
    </div>
  );
}
