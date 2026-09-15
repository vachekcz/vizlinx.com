export type FrameRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type Placement = { x: number; y: number; zoom: number };

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Find a camera translation without changing any node's relative position. */
export function fitAroundObstacles(
  bounds: FrameRect,
  nodes: FrameRect[],
  frame: FrameRect,
  obstacles: FrameRect[],
): Placement | null {
  const maxZoom = Math.min(
    2.8,
    (frame.right - frame.left) / (bounds.right - bounds.left),
    (frame.bottom - frame.top) / (bounds.bottom - bounds.top),
  );
  if (!Number.isFinite(maxZoom) || maxZoom <= 0) return null;

  const place = (zoom: number): Placement | null => {
    const left = frame.left - bounds.left * zoom;
    const right = frame.right - bounds.right * zoom;
    const top = frame.top - bounds.top * zoom;
    const bottom = frame.bottom - bounds.bottom * zoom;
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    // Each node/obstacle pair forbids a rectangle of camera translations.
    const forbidden = nodes.flatMap((node) =>
      obstacles.map((obstacle) => ({
        left: obstacle.left - node.right * zoom,
        right: obstacle.right - node.left * zoom,
        top: obstacle.top - node.bottom * zoom,
        bottom: obstacle.bottom - node.top * zoom,
      })),
    );
    const candidates = new Set([
      centerX,
      left,
      right,
      ...forbidden.flatMap((rect) => [
        clamp(rect.left, left, right),
        clamp(rect.right, left, right),
      ]),
    ]);
    let best: Placement | null = null;
    let distance = Infinity;
    for (const x of candidates) {
      if ((x - centerX) ** 2 >= distance) continue;
      const intervals = forbidden
        .filter((rect) => x > rect.left + 0.001 && x < rect.right - 0.001)
        .sort((a, b) => a.top - b.top);
      const consider = (start: number, end: number) => {
        if (end < start) return;
        const y = clamp(centerY, start, end);
        const nextDistance = (x - centerX) ** 2 + (y - centerY) ** 2;
        if (nextDistance < distance) {
          best = { x, y, zoom };
          distance = nextDistance;
        }
      };
      let start = top;
      for (const interval of intervals) {
        if (interval.bottom <= start || interval.top >= bottom) continue;
        consider(start, Math.min(bottom, interval.top));
        start = Math.max(start, interval.bottom);
        if (start > bottom) break;
      }
      consider(start, bottom);
    }
    return best;
  };

  // Feasibility need not be monotonic: nodes can straddle a small panel.
  // Search from large to small first, then refine the first fitting interval.
  let upper = maxZoom;
  for (let step = 0; step <= 100; step++) {
    const zoom = maxZoom * 0.94 ** step;
    let placement = place(zoom);
    if (placement) {
      let lower = zoom;
      for (let iteration = 0; iteration < 12; iteration++) {
        const middle = (lower + upper) / 2;
        const candidate = place(middle);
        if (candidate) {
          placement = candidate;
          lower = middle;
        } else upper = middle;
      }
      return placement;
    }
    upper = zoom;
  }
  return null;
}
