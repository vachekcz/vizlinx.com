import { useEffect, useState } from 'react';
import type { DOMAttributes } from 'react';
import { Globe2, Link2, Play } from 'lucide-react';
import type { GraphHighlightStyle, GraphHighlightTarget } from '../Graph';
import './hover-studies.css';

const variants = [
  {
    id: 'pulse',
    label: '1 · Puls',
    description:
      'Jeden puls kolem webu; světelný úsek po spojnici ve směru odkazu.',
  },
  {
    id: 'quiet',
    label: '2 · Klid',
    description:
      'Silnější obrys, jemná záře a zvýrazněná spojnice. Bez pohybu.',
  },
  {
    id: 'focus',
    label: '3 · Soustředění',
    description:
      'Web nebo propojení vystoupí do popředí, okolní mapa se ztlumí.',
  },
] as const;

export type PreviewEvents = (
  target: GraphHighlightTarget,
) => DOMAttributes<Element>;

export function useHoverStudies(enabled: boolean) {
  const [mode, setMode] = useState<GraphHighlightStyle | null>(() => {
    const requested = new URLSearchParams(window.location.search).get('hover');
    return enabled
      ? (variants.find((variant) => variant.id === requested)?.id ?? null)
      : null;
  });
  const [pointerTarget, setPointerTarget] =
    useState<GraphHighlightTarget | null>(null);
  const [focusTarget, setFocusTarget] = useState<GraphHighlightTarget | null>(
    null,
  );
  const [demoTarget, setDemoTarget] = useState<GraphHighlightTarget | null>(
    null,
  );
  const [replayKey, setReplayKey] = useState(0);
  const target = pointerTarget ?? focusTarget ?? demoTarget;
  const highlightStyle = mode ?? (target?.type === 'page' ? 'pulse' : null);

  useEffect(() => {
    if (!demoTarget) return;
    const timer = window.setTimeout(() => setDemoTarget(null), 3000);
    return () => window.clearTimeout(timer);
  }, [demoTarget, replayKey]);

  const clear = () => {
    setPointerTarget(null);
    setFocusTarget(null);
    setDemoTarget(null);
  };
  const changeMode = (next: GraphHighlightStyle | null) => {
    setMode(next);
    setPointerTarget(null);
    setFocusTarget(null);
    if (!next) setDemoTarget(null);
    setReplayKey((previous) => previous + 1);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('hover', next);
    else url.searchParams.delete('hover');
    window.history.replaceState(null, '', url);
  };
  const previewEvents: PreviewEvents = (next) =>
    enabled && (mode || next.type === 'page')
      ? {
          onPointerMove: (event) => {
            if (event.pointerType === 'touch') return;
            const separateAction = (event.target as Element).closest(
              '.external-link, .ux-site-action',
            );
            setPointerTarget((previous) =>
              separateAction
                ? null
                : previous?.type === next.type && previous.id === next.id
                  ? previous
                  : next,
            );
            setDemoTarget(null);
          },
          onPointerLeave: () => setPointerTarget(null),
          onFocus: (event) => {
            if (
              event.target.matches(':focus-visible') &&
              !event.target.closest('.external-link, .ux-site-action')
            ) {
              setFocusTarget(next);
              setDemoTarget(null);
            }
          },
          onBlur: () => setFocusTarget(null),
        }
      : {};

  return {
    mode,
    changeMode,
    clear,
    previewEvents,
    target: highlightStyle ? target : null,
    playing: Boolean(mode && demoTarget),
    highlight:
      highlightStyle && target
        ? { target, style: highlightStyle, replayKey }
        : undefined,
    play: (next: GraphHighlightTarget) => {
      setPointerTarget(null);
      setFocusTarget(null);
      setDemoTarget(next);
      setReplayKey((previous) => previous + 1);
    },
  };
}

export default function HoverStudies({
  mode,
  onChange,
  onPlaySite,
  onPlayConnection,
}: {
  mode: GraphHighlightStyle;
  onChange: (mode: GraphHighlightStyle) => void;
  onPlaySite: () => void;
  onPlayConnection: () => void;
}) {
  return (
    <section className="ux-hover-studies" aria-label="Porovnání hover efektů">
      <div className="ux-hover-study-choice">
        <span>HOVER V MAPĚ</span>
        <div role="group" aria-label="Varianta hover efektu">
          {variants.map((variant) => (
            <button
              key={variant.id}
              aria-pressed={mode === variant.id}
              onClick={() => onChange(variant.id)}
            >
              {variant.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="ux-hover-study-play"
        role="group"
        aria-label="Přehrát ukázku"
      >
        <button onClick={onPlaySite}>
          <Globe2 size={14} /> Ukázka webu <Play size={11} />
        </button>
        <button onClick={onPlayConnection}>
          <Link2 size={14} /> Ukázka propojení <Play size={11} />
        </button>
      </div>
      <p>
        {variants.find((variant) => variant.id === mode)?.description}{' '}
        <span>
          Najeď na řádek webu nebo jeho propojení, případně přehraj ukázku.
        </span>
      </p>
    </section>
  );
}
