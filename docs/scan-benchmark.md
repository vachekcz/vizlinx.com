# Benchmark HTML skenování

Benchmark slouží k ověření současného skeneru před rozhodnutím o serverové variantě. Používá přímo `extension/fetch-page.ts`, tedy stejný parser, limit HTML 2 MiB, limit výsledku, zpracování robots.txt a klasifikaci chyb jako rozšíření. Běží v Node.js na počítači operátora, nikoli na Cloudflare. Nemění mapy ani produkční databázi.

## Spuštění

```sh
# Kontrolovaný web na náhodném lokálním portu; výchozí limit je 20 stránek.
npm run benchmark:scan -- --fixture --pages 50

# Vlastní nebo spravovaný veřejný web; nejvýše tři seed URL.
npm run benchmark:scan -- https://your-domain.com/ --pages 20

# Regresní kontroly fronty, omezení a výpočtu.
npm run test:benchmark
```

Report se ukládá do ignorovaného `test-results/scan-benchmark.json`; jiné umístění lze nastavit přes `--output`. Obsahuje URL navštívených stránek, proto se před sdílením musí zkontrolovat například parametry URL.

Veřejné weby se procházejí postupně, nejvýše 50 stránek na seed, s minimálním odstupem jednu sekundu mezi začátky požadavků. Delší `Crawl-delay` se respektuje. Každý seed má rozpočet dvě minuty; právě běžící požadavek může doběhnout do svého dvacetisekundového timeoutu. Při dlouhém robots intervalu se benchmark zastaví, místo aby požadavek poslal předčasně.

Skener zůstává na přesném originu, neposílá cookies, nespouští JavaScript a nenásleduje přesměrování. Seed proto musí být konečná URL, například správná varianta s `www`. Přesměrování nebo chyba při čtení robots mohou sken zastavit. Bez dostupných HTML odkazů může sken skončit už po jedné stránce. Počet úspěšných stránek se vykazuje odděleně od pokusů a chyb.

Je to nástroj pro ruční spuštění s důvěryhodným vstupem operátora. Nesmí se přímo vystavit jako veřejné API: veřejný serverový skener potřebuje ochranu proti přístupu do privátní sítě, autentizaci nebo kvóty, frontu a vlastní identitu crawleru.

## Co výsledky znamenají

- `wallMs` zahrnuje robots, stahování, zpracování a čekání mezi požadavky.
- `pageWallMsP50/P95` popisuje dobu pokusu o stránku bez plánovaného odstupu. Zahrnuje i neúspěšné pokusy; jejich počet je v `statusCounts`.
- `localProcessCpuMs` měří lokální proces během požadavků a serializace. U fixture zahrnuje také její HTTP server a může zahrnovat práci pomocných vláken. **Není to účtovaný CPU čas Workers.**
- `structuredBytes` je velikost serializovaných výsledků. Není to stažené HTML ani skutečná velikost databáze s jejími indexy.
- `cpuOnlyScenarios` jsou výpočty pro zadané předpoklady 20, 100 a 500 ms CPU na stránku. Neodvozují se z lokálního měření.

První kontrolovaný běh 12. 9. 2026 na macOS/arm64 prošel 50 stránek s přibližně 5, 87 a 685 KiB HTML. Všech 50 pokusů uspělo; běh trval 0,65 s a výsledky měly 332 KiB. Lokální proces spotřeboval přibližně 778 ms CPU. Fixture nemá síťovou latenci veřejného internetu ani povinný sekundový odstup, takže tento čas **není odhadem doby skenu veřejného webu**. Není to ani zátěžový test souběžných uživatelů.

Stejný den proběhl také lokální sken veřejného `https://vizlinx.com/`: jedna úspěšná stránka, 1,37 s celkem včetně robots a odstupu, 196 B strukturovaného výsledku. Ve vstupním HTML nebyly další procházené odkazy; aplikace se vykresluje JavaScriptem. Tento pokus ověřuje veřejné HTTP stažení, ale nereprezentuje vícestránkový web ani přístup z Cloudflare.

## Model Workers Paid

Podle [ceníku Workers](https://developers.cloudflare.com/workers/platform/pricing/) ověřeného 12. 9. 2026 zahrnuje základ od 5 USD měsíčně 30 milionů CPU ms a 10 milionů příchozích požadavků. Zahrnutá spotřeba je společná pro účet, nikoli pro každou aplikaci. Odchozí `fetch` se neúčtuje jako další příchozí požadavek.

| Předpokládaný celkový CPU čas na stránku | Stránek v zahrnutém CPU / měsíc | Skenů po 50 stránkách |
| --- | ---: | ---: |
| 20 ms | 1 500 000 | 30 000 |
| 100 ms | 300 000 | 6 000 |
| 500 ms | 60 000 | 1 200 |

Výpočet je `30 000 000 / CPU ms na stránku`. Předpokládá, že celý zahrnutý CPU příděl zůstává skeneru, a neřeší ostatní limity. Není to garantovaná kapacita celé služby. Po překročení přídělu se další milion CPU ms účtuje 0,02 USD; služba se kvůli samotnému překročení zahrnuté spotřeby automaticky nezastaví.

Samostatně se počítají požadavky a ukládání do D1, případná fronta, logy, opakované pokusy, údržba a prohlížení map. Účet může spotřebovávat i jiný projekt. Vzdálený prohlížeč má [vlastní účtování](https://developers.cloudflare.com/browser-run/pricing/) a není součástí těchto scénářů. Skutečný aktivní tarif účtu se nepodařilo potvrdit: token smí číst nastavení Workers, ale čtení předplatného vrací 403.

## Následující měření na Cloudflare

Lokální benchmark ověřuje nástroj a vlastnosti vstupních dat. Pro skutečnou cenu a dostupnost potřebujeme samostatný omezený pilot na Cloudflare: stejné stránky stáhnout z Workers, odečíst CPU a požadavky z platformních metrik a D1 čtení/zápisy z metadat databáze. Oddělit parser od celkové režie, zahrnout neúspěšné pokusy, sledovat velikost databáze a ověřit několik současných skenů. Až tato data umožní nahradit předpoklady v tabulce naměřenými hodnotami.

Padesát stránek v cenových scénářích je pouze velikost modelového skenu. Navazující [serverový prototyp](01-backend.md) používá nejvýše 3 originy a 100 stránek na origin; jeho provozní limity se řídí samostatným kontraktem. Tento lokální benchmark nadále neměří účtovaný CPU čas Cloudflare.
