export type ThemeId =
  'original' | 'signal' | 'carbon' | 'midnight' | 'electric' | 'editorial';

export const themes: {
  id: ThemeId;
  name: string;
  description: string;
  colors: string[];
}[] = [
  {
    id: 'signal',
    name: 'Signal',
    description: 'Čistá bílá, ostrá modrá, výrazné barvy webů.',
    colors: ['#ffffff', '#172139', '#2457ff', '#d73763'],
  },
  {
    id: 'carbon',
    name: 'Carbon',
    description: 'Grafitová plocha s elektrickou limetkou.',
    colors: ['#101114', '#24272d', '#c0ff45', '#7197ff'],
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Hluboká námořní modř a zářivý tyrkys.',
    colors: ['#071023', '#162543', '#39d9ef', '#ff827a'],
  },
  {
    id: 'electric',
    name: 'Electric',
    description: 'Tmavá fialová, magenta a digitální kontrast.',
    colors: ['#100b21', '#261b3b', '#bda0ff', '#ff71d7'],
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Černobílá přesnost s výrazným oranžovým akcentem.',
    colors: ['#ffffff', '#171717', '#df3d1a', '#124ed8'],
  },
  {
    id: 'original',
    name: 'Původní',
    description: 'Původní pastelová varianta pro porovnání.',
    colors: ['#f7f8f5', '#e5efe3', '#285c46', '#eee7f6'],
  },
];

export function initialTheme(): ThemeId {
  const id = new URLSearchParams(window.location.search).get('theme');
  return themes.find((theme) => theme.id === id)?.id ?? 'original';
}
