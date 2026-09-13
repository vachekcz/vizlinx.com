import { ExternalLink as ExternalLinkIcon } from 'lucide-react';

function externalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export default function ExternalLink({ url }: { url: string }) {
  const href = externalUrl(url);
  if (!href) return null;
  const label = `Otevřít ${url} v nové kartě`;
  return (
    <a
      className="external-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
    >
      <ExternalLinkIcon size={14} aria-hidden="true" />
    </a>
  );
}

export function GraphExternalLink({
  url,
  x,
  y,
  touch = false,
}: {
  url: string;
  x: number;
  y: number;
  touch?: boolean;
}) {
  const href = externalUrl(url);
  if (!href) return null;
  return (
    <g transform={`translate(${x} ${y})`}>
      <a
        className="graph-external-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Otevřít ${url} v nové kartě`}
        data-interactive="true"
      >
        <title>{`Otevřít ${url} v nové kartě`}</title>
        <rect
          className="graph-external-hit"
          x={touch ? -9 : 0}
          y={touch ? -9 : 0}
          width={touch ? 44 : 26}
          height={touch ? 44 : 26}
          rx="6"
        />
        <rect
          className="graph-external-background"
          width="26"
          height="26"
          rx="6"
          pointerEvents="none"
        />
        <ExternalLinkIcon
          x={6}
          y={6}
          width={14}
          height={14}
          aria-hidden="true"
          pointerEvents="none"
        />
      </a>
    </g>
  );
}
