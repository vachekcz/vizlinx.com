export type ConnectionStyleId =
  'strands' | 'fan' | 'ribbon' | 'pulses' | 'metro';

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
];
