import {
  isFineConnectionStyle,
  type ConnectionStyleId,
} from './connectionStyles';
import FineConnectionStroke from './FineConnectionStroke';

type Point = { x: number; y: number };

type Props = {
  variant: ConnectionStyleId;
  from: Point;
  to: Point;
  control: Point;
  color: string;
  count: number;
  selected: boolean;
  markerId: string;
};

function curvePoint(from: Point, control: Point, to: Point, t: number) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

function curveDirection(from: Point, control: Point, to: Point, t: number) {
  const x = (1 - t) * (control.x - from.x) + t * (to.x - control.x);
  const y = (1 - t) * (control.y - from.y) + t * (to.y - control.y);
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

function chevron(point: Point, direction: Point, size: number) {
  const base = {
    x: point.x - direction.x * size,
    y: point.y - direction.y * size,
  };
  return `M ${base.x - direction.y * size * 0.65} ${base.y + direction.x * size * 0.65} L ${point.x} ${point.y} L ${base.x + direction.y * size * 0.65} ${base.y - direction.x * size * 0.65}`;
}

export default function ConnectionStroke({
  variant,
  from,
  to,
  control,
  color,
  count,
  selected,
  markerId,
}: Props) {
  if (isFineConnectionStyle(variant)) {
    return (
      <FineConnectionStroke
        variant={variant}
        from={from}
        to={to}
        control={control}
        color={color}
        count={count}
        selected={selected}
      />
    );
  }

  const strength = Math.min(5, Math.max(1, Math.floor(count)));
  const distance = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const normal = {
    x: -(to.y - from.y) / distance,
    y: (to.x - from.x) / distance,
  };
  const path = `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`;
  const shared = {
    className: 'connection-stroke',
    pointerEvents: 'none' as const,
    fill: 'none',
    stroke: color,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (variant === 'ribbon') {
    return (
      <>
        <path
          {...shared}
          data-testid="aggregate-strand"
          d={path}
          strokeWidth={4 + strength * 3 + (selected ? 2 : 0)}
          opacity={selected ? 0.38 : 0.24}
        />
        <path
          {...shared}
          d={path}
          strokeWidth={selected ? 2.6 : 1.8}
          opacity={selected ? 1 : 0.8}
          markerEnd={`url(#${markerId})`}
        />
        <path
          {...shared}
          d={chevron(
            curvePoint(from, control, to, 0.76),
            curveDirection(from, control, to, 0.76),
            5 + strength,
          )}
          strokeWidth={2.4}
        />
      </>
    );
  }

  if (variant === 'pulses') {
    return (
      <>
        <path
          {...shared}
          data-testid="aggregate-strand"
          d={path}
          strokeWidth={1 + strength * 0.9 + (selected ? 1 : 0)}
          opacity={selected ? 0.5 : 0.25}
          markerEnd={`url(#${markerId})`}
        />
        {Array.from({ length: strength + 1 }, (_, index) => {
          const t = 0.15 + (index / strength) * 0.68;
          return (
            <path
              {...shared}
              key={index}
              d={chevron(
                curvePoint(from, control, to, t),
                curveDirection(from, control, to, t),
                4 + strength * 0.8,
              )}
              strokeWidth={selected ? 2.6 : 2}
              opacity={selected ? 1 : 0.85}
            />
          );
        })}
      </>
    );
  }

  // Leave clearance at each domain before separating the individual lanes.
  const trim = Math.min(0.15, 12 / distance);
  const start = curvePoint(from, control, to, trim);
  const end = curvePoint(from, control, to, 1 - trim);
  const trimmedControl = {
    x:
      start.x +
      (1 - 2 * trim) *
        ((1 - trim) * (control.x - from.x) + trim * (to.x - control.x)),
    y:
      start.y +
      (1 - 2 * trim) *
        ((1 - trim) * (control.y - from.y) + trim * (to.y - control.y)),
  };
  const spacing = variant === 'metro' ? 5 : variant === 'fan' ? 4 : 3;

  return (
    <>
      {Array.from({ length: strength }, (_, index) => {
        const lane = index - (strength - 1) / 2;
        const offset = lane * spacing;
        const laneStart = {
          x: start.x + normal.x * offset,
          y: start.y + normal.y * offset,
        };
        const laneEnd = {
          x: end.x + normal.x * offset,
          y: end.y + normal.y * offset,
        };
        const spread = variant === 'fan' ? lane * 21 : offset;
        const laneControl = {
          x: trimmedControl.x + normal.x * spread,
          y: trimmedControl.y + normal.y * spread,
        };
        const lanePath =
          variant === 'metro'
            ? `M ${laneStart.x} ${laneStart.y} C ${laneControl.x} ${laneControl.y} ${laneControl.x} ${laneControl.y} ${laneEnd.x} ${laneEnd.y}`
            : `M ${laneStart.x} ${laneStart.y} Q ${laneControl.x} ${laneControl.y} ${laneEnd.x} ${laneEnd.y}`;
        return (
          <path
            {...shared}
            data-testid="aggregate-strand"
            key={index}
            d={lanePath}
            strokeWidth={selected ? 2.1 : variant === 'metro' ? 1.8 : 1.5}
            strokeDasharray={variant === 'metro' ? '13 5' : undefined}
            strokeDashoffset={variant === 'metro' ? index * 3 : undefined}
            opacity={selected ? 1 : 0.76}
            markerEnd={`url(#${markerId})`}
          />
        );
      })}
    </>
  );
}
