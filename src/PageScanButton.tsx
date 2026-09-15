import { Clock3, LoaderCircle, Play } from 'lucide-react';
import type { Page } from './data';
import { pageStatusLabel } from './graph-data';

export type PageScanControl = {
  onScanPage?: (url: string) => void;
  controlsDisabled?: boolean;
};

type Props = PageScanControl & { page: Page };

export default function PageScanButton({
  page,
  onScanPage,
  controlsDisabled,
}: Props) {
  if (!onScanPage || page.status !== 'known' || !page.url) return null;
  const pending = Boolean(page.scanState);
  const label = pending ? pageStatusLabel(page) : 'Proskenovat';
  const Icon =
    page.scanState === 'fetching' ? LoaderCircle : pending ? Clock3 : Play;
  return (
    <button
      className="outline-button page-scan-button"
      disabled={controlsDisabled || pending || Boolean(page.scanDisabledReason)}
      aria-label={`${label} ${page.url}`}
      title={page.scanDisabledReason ?? `${label} ${page.url}`}
      onClick={() => onScanPage(page.url!)}
    >
      <Icon size={15} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export function GraphPageScanButton({
  page,
  onScanPage,
  controlsDisabled,
  x,
  y,
}: Props & { x: number; y: number }) {
  if (!onScanPage || page.status !== 'known' || !page.url) return null;
  const disabled =
    controlsDisabled ||
    Boolean(page.scanState) ||
    Boolean(page.scanDisabledReason);
  const label = `${page.scanState ? pageStatusLabel(page) : 'Proskenovat'} ${page.url}`;
  const Icon =
    page.scanState === 'fetching'
      ? LoaderCircle
      : page.scanState
        ? Clock3
        : Play;
  const activate = () => {
    if (!disabled) onScanPage(page.url!);
  };
  return (
    <g
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      className="graph-page-scan"
      data-interactive="true"
      onClick={(event) => {
        event.stopPropagation();
        activate();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          activate();
        }
      }}
    >
      <title>{page.scanDisabledReason ?? label}</title>
      <rect width={26} height={26} rx={6} />
      <Icon
        x={6}
        y={6}
        width={14}
        height={14}
        aria-hidden="true"
        pointerEvents="none"
      />
    </g>
  );
}
