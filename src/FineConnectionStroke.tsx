import ArrowHead from './ArrowHead';
import type { FineConnectionStyleId } from './connectionStyles';

type Point = { x: number; y: number };

type Props = {
  variant: FineConnectionStyleId;
  from: Point;
  to: Point;
  control: Point;
  color: string;
  count: number;
  selected: boolean;
};

const hairlineWidth = 0.7;

// Keep the same strength scale in the map and the isolated comparison page.
export function fineConnectionStrength(count: number) {
  const boundedCount = Math.min(100, Math.max(1, Math.floor(count)));
  if (boundedCount <= 5) {
    return {
      count: boundedCount,
      width: hairlineWidth + (boundedCount - 1) * 1.8,
    };
  }
  const stops = [
    [5, 7.9],
    [10, 10],
    [25, 13],
    [50, 17],
    [100, 22],
  ];
  for (let index = 1; index < stops.length; index += 1) {
    const [upperCount, upperWidth] = stops[index];
    const [lowerCount, lowerWidth] = stops[index - 1];
    if (boundedCount <= upperCount) {
      const progress = (boundedCount - lowerCount) / (upperCount - lowerCount);
      return {
        count: boundedCount,
        width: lowerWidth + (upperWidth - lowerWidth) * progress,
      };
    }
  }
  return { count: boundedCount, width: 22 };
}

function pointAt(from: Point, control: Point, to: Point, t: number) {
  const inverse = 1 - t;
  const tangentX = inverse * (control.x - from.x) + t * (to.x - control.x);
  const tangentY = inverse * (control.y - from.y) + t * (to.y - control.y);
  const length = Math.hypot(tangentX, tangentY) || 1;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
    normalX: -tangentY / length,
    normalY: tangentX / length,
  };
}

export default function FineConnectionStroke({
  variant,
  from,
  to,
  control,
  color,
  count,
  selected,
}: Props) {
  if (!Number.isFinite(count) || count <= 0) return null;

  const strength = fineConnectionStrength(count);
  const isBundle = strength.count > 5;
  const strandCount = isBundle
    ? variant === 'silk'
      ? Math.min(25, Math.ceil(strength.width / 0.8))
      : variant === 'cable'
        ? Math.min(13, Math.ceil(strength.width / 1.6))
        : 4
    : strength.count;
  const distance = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const trim = Math.min(0.1, 6 / distance);
  const centerPath = `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`;

  // Sample offsets against the local normal so curved bundles keep even spacing.
  function lanePath(offset: number, start = trim, end = 1 - trim) {
    const points = Array.from({ length: 41 }, (_, index) => {
      const t = start + ((end - start) * index) / 40;
      const point = pointAt(from, control, to, t);
      const taper = Math.min(1, t / 0.13, (1 - t) / 0.13);
      const gather =
        variant === 'cable'
          ? 1 - (isBundle ? 0.68 : 0.22) * Math.sin(Math.PI * t) ** 4
          : variant === 'silk'
            ? 0.88 + 0.12 * Math.sin(Math.PI * t)
            : 1;
      const shift = offset * taper * gather;
      return `${index === 0 ? 'M' : 'L'} ${point.x + point.normalX * shift} ${point.y + point.normalY * shift}`;
    });
    return points.join(' ');
  }

  const end = pointAt(from, control, to, 1 - trim / 2);
  const arrowAngle = Math.atan2(-end.normalX, end.normalY) * (180 / Math.PI);
  const shared = {
    className: 'connection-stroke',
    fill: 'none',
    stroke: color,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <g
      pointerEvents="none"
      data-strength-width={strength.width}
      data-fine-style={variant}
    >
      {isBundle && variant !== 'cable' && (
        <path
          {...shared}
          d={centerPath}
          strokeWidth={Math.max(1, strength.width - 1.4)}
          opacity={
            variant === 'contour'
              ? selected
                ? 0.28
                : 0.2
              : selected
                ? 0.17
                : 0.1
          }
        />
      )}
      {isBundle && variant === 'cable' && (
        <path
          {...shared}
          d={lanePath(0, 0.26, 0.74)}
          strokeWidth={strength.width}
          opacity={selected ? 0.9 : 0.73}
        />
      )}
      {Array.from({ length: strandCount }, (_, index) => {
        const ratio = strandCount === 1 ? 0 : index / (strandCount - 1) - 0.5;
        const contourRatio = [-0.5, -0.36, 0.36, 0.5][index];
        const offset =
          (isBundle && variant === 'contour' ? contourRatio : ratio) *
          (strength.width - hairlineWidth);
        return (
          <path
            {...shared}
            key={index}
            data-testid="fine-strand"
            d={lanePath(offset)}
            strokeWidth={hairlineWidth}
            opacity={
              selected ? 1 : isBundle && variant === 'silk' ? 0.56 : 0.82
            }
          />
        );
      })}
      <g transform={`translate(${end.x} ${end.y}) rotate(${arrowAngle})`}>
        <ArrowHead color={color} />
      </g>
    </g>
  );
}
