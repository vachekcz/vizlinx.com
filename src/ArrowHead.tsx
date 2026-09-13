export default function ArrowHead({ color }: { color: string }) {
  return (
    <path
      className="connection-arrow"
      d="M 0 0 L -13 -6.5 L -10 0 L -13 6.5 Z"
      fill={color}
      stroke="var(--surface, #fff)"
      strokeWidth={2}
      strokeLinejoin="round"
      paintOrder="stroke fill"
      pointerEvents="none"
    />
  );
}
