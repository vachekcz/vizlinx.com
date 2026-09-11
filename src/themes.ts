import { useEffect, useState } from 'react';

export type ThemeId = 'signal' | 'midnight';
const storageKey = 'vizlinx-theme';
const darkQuery = '(prefers-color-scheme: dark)';

function isTheme(value: string | null): value is ThemeId {
  return value === 'signal' || value === 'midnight';
}

function preferredTheme(): ThemeId | null {
  const query = new URLSearchParams(window.location.search).get('theme');
  if (isTheme(query)) return query;
  try {
    const saved = window.localStorage.getItem(storageKey);
    return isTheme(saved) ? saved : null;
  } catch {
    return null;
  }
}

function systemTheme(): ThemeId {
  return window.matchMedia(darkQuery).matches ? 'midnight' : 'signal';
}

export function initialTheme(): ThemeId {
  return preferredTheme() ?? systemTheme();
}

export function useTheme() {
  const [preference, setPreference] = useState(preferredTheme);
  const [system, setSystem] = useState(systemTheme);
  const theme = preference ?? system;

  useEffect(() => {
    const query = window.matchMedia(darkQuery);
    const update = () => setSystem(query.matches ? 'midnight' : 'signal');
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'signal' ? 'midnight' : 'signal';
    setPreference(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // The toggle still works when browser storage is unavailable.
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('theme');
    window.history.replaceState(null, '', url);
  };

  return { theme, toggleTheme };
}
