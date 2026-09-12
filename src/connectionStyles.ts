export type FineConnectionStyleId = 'silk' | 'contour' | 'cable';

export type ConnectionStyleId =
  'strands' | 'fan' | 'ribbon' | 'pulses' | 'metro' | FineConnectionStyleId;

export function isFineConnectionStyle(id: string): id is FineConnectionStyleId {
  return id === 'silk' || id === 'contour' || id === 'cable';
}

export function connectionStrengthLabel(count: number): string {
  if (count >= 100) return '100+';
  if (count >= 50) return '50+';
  if (count >= 25) return '25+';
  if (count >= 10) return '10+';
  if (count > 5) return '5+';
  return String(Math.max(0, Math.floor(count)));
}

export const fineConnectionStyles: {
  id: FineConnectionStyleId;
  name: string;
  description: string;
}[] = [
  {
    id: 'silk',
    name: 'Hedvábí',
    description:
      'Jednotlivá tenká vlákna se postupně slévají do hustého svazku. Síla roste až do 100+.',
  },
  {
    id: 'contour',
    name: 'Kontury',
    description:
      'Jemné čáry u slabých vazeb, průsvitný pás s tenkými obrysy u silných.',
  },
  {
    id: 'cable',
    name: 'Kabel',
    description:
      'Tenké větve se u silnějších vazeb spojují do společného výrazného středu.',
  },
];

export const connectionStyles: {
  id: ConnectionStyleId;
  name: string;
  description: string;
}[] = [
  {
    id: 'strands',
    name: 'Vlákna',
    description: 'Až pět jemných souběžných čar. Každý odkaz má vlastní šipku.',
  },
  {
    id: 'fan',
    name: 'Vějíř',
    description:
      'Odkazy se rozbíhají do samostatných oblouků. Silná vazba zabere více prostoru.',
  },
  {
    id: 'ribbon',
    name: 'Pásy',
    description:
      'Šířka barevného pásu vyjadřuje sílu vazby. Šipka ukazuje směr.',
  },
  {
    id: 'pulses',
    name: 'Proud',
    description:
      'Výrazné směrové značky vedou oko po vazbě. Více odkazů zesiluje proud.',
  },
  {
    id: 'metro',
    name: 'Metro',
    description:
      'Oddělené přerušované linky s klidnějšími ohyby. Každý směr má vlastní svazek.',
  },
  ...fineConnectionStyles,
];
