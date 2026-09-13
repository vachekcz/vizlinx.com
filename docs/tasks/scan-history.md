# Historie a opakované skenování jedné mapy

Mapa představuje sestavu až tří webů a má stálou adresu `/scan?id=…`. „Skenovat znovu“ uloží dosavadní průchod včetně výsledků, nastavení a logu a spustí nový. Nové výsledky se od začátku zobrazují živě. Zmizelé stránky a odkazy se nepřenášejí z předchozího průchodu. Porovnávání rozdílů mezi průchody není součástí této změny.

## Ovládání

Opakované spuštění je v horní liště mapy. Při běhu je zakázané; běh je nejprve potřeba pozastavit. „Pokračovat ve skenování“ zachovává aktuální průchod a jeho již zpracované URL, zatímco „Skenovat znovu“ začíná od výchozích adres. Intervaly a pauzy jednotlivých webů se přebírají, takže pozastavený web zůstane pozastavený.

Výběr „Historie skenů“ ukazuje číslo, datum a stav. Archivní pohled má adresu `/scan?id=…&run=…`, označení historie a návrat na aktuální sken. Graf, tabulka a log odpovídají zvolenému průchodu; historické výsledky a nastavení nelze měnit ani přes detail domény. Archiv pozastaveného nebo přerušeného průchodu zůstává označený jako nedokončený. Pokračovat lze jen v aktuálním průchodu. Běh aktuálního skenu není prohlížením historie přerušen.

Graf i otevřený log se při změně průchodu resetují. Opožděné odpovědi ze starého zobrazení se nepoužijí. Aktuální mapa se obnovuje i po dokončení, aby zachytila opakované spuštění v jiné kartě. Archiv se pravidelně nedotazuje.

## Ukládání a API

Migrace `0006_scan_history.sql` doplňuje identitu aktuálního průchodu v `scans`. Dosavadní mapy zůstávají prvním průchodem bez přesunu nebo mazání dat. Tabulky `scan_runs`, `scan_run_pages` a `scan_run_events` ukládají archivní metadata, jednotlivé výsledky a události. Výsledky nejsou spojeny do jednoho velkého JSON řádku.

| Endpoint | Význam |
| --- | --- |
| `GET /api/v1/scans/:id` | Aktuální živý průchod, stabilní ID mapy |
| `GET /api/v1/scans/:id/runs` | Souhrny průchodů od nejnovějšího a kapacita historie |
| `GET /api/v1/scans/:id/runs/:runId` | Výsledky konkrétního průchodu |
| `GET /api/v1/scans/:id/runs/:runId/log` | Log konkrétního průchodu |
| `POST /api/v1/scans/:id/rescan` | Archivace a nový serverový průchod, tělo `{ "runId": "aktuální UUID" }` |

Všechny nové endpointy ověřují vlastnictví i platnost mapy. Snapshoty přidávají `runId`, `runNumber`, `runCreatedAt` a `archived`. Stávající endpointy zůstávají kompatibilní; nový frontend posílá `runId` také u startu, pauzy, nastavení a přidání webu, aby zastaralá karta neměnila novější průchod.

Archivace a vyčištění živých výsledků, logu, frontier a robots jsou jedna transakce D1. Podmínka aktuálního ID a generace přijme jen jedno souběžné opakované spuštění. Zneplatní se staré lease i případná oprávnění rozšíření. Pozdní výsledky předchozího průchodu už neprojdou generační kontrolou. Teprve poté se nový průchod spustí přes existující frontu. Pokud doručení do fronty selže, archiv zůstává uložený a aktuální průchod lze znovu spustit. Snapshot i log se čtou konzistentně v transakci i při souběžné archivaci.

## Limity

Každý nový průchod má limit 100 pokusů na web, 4 MiB výsledků a stávající časový limit. Společný denní rozpočet požadavků a rychlostní brány originů se nerestartují. Opakované spuštění spotřebuje stejnou kvótu startů jako běžný start nebo pokračování.

Prozatím lze v jedné mapě uložit nejvýše 10 průchodů včetně aktuálního. Po dosažení kapacity se další spuštění odmítne a rozhraní nabídne kontaktovat správce; žádná historie se kvůli novému průchodu nemaže. Platnost všech průchodů končí s mapou 30 dní od jejího založení. Opakování skenu tuto dobu neprodlužuje. Smazání nebo úklid mapy odstraní archiv přes cizí klíče.

## Ověření

Regresní API testy kontrolují zachování starých map, archivaci výsledků i logů, prázdný nový průchod, souběžné spuštění, odmítnutí zastaralých ovládacích požadavků, vlastnictví, expiraci, kapacitu historie a nezměněné globální limity. Řízená opožděná HTML odpověď po pauze a opakovaném skenu nesmí změnit žádný z průchodů.

Desktopové a mobilní scénáře ověřují živé aktualizace, archiv po reloadu, jeho neměnné ovládání a pozdní snapshot/log při přepnutí. Kompletní E2E používá Worker, Queue a D1: změní HTML mezi dvěma průchody, během druhého otevře starší výsledky a log, vrátí se na aktuální mapu a ověří, že odstraněné URL zůstaly pouze v historii.

Ověřeno 13. 9. 2026: 43 API testů (14 pro historii), 54 testů rozhraní skenu, 23 crawler testů a 4 testy logu. Prošly také kompletní E2E, historické rozšíření, build, formátování a Wrangler dry-run. Migrace byla aplikována lokálně i do produkční D1.

Produkční verze `d75d181e-61b8-4b61-91b3-aab66e65e6a5` dokončila dva skutečné průchody jedné diagnostické mapy. Druhý průchod načetl stejnou URL s novým časem pozorování, zachoval původní výsledky a log v historii a souhrn vrátil dva průchody pod jedním ID mapy. Čtení historie bez vlastnické cookie vrátilo 401.
