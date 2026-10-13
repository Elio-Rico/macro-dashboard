# Macro & Fiscal Monitor

A dashboard of growth, inflation, public finances, debt by sector and exchange rates for a
set of economies. The data are fetched daily from public APIs (no keys needed) by an R
script; a small static web page draws the charts.

Live: <https://www.eliobolliger.com/dashboard/> (proxied from GitHub Pages)

## How it works

```
GitHub Actions (daily, 16:47 UTC)
  └─ Rscript R/update_data.R  ──► docs/data/*.json  ──► committed to the repo
                                                    └─► docs/ deployed to GitHub Pages
Netlify (eliobolliger.com) proxies /dashboard/* to the GitHub Pages site
```

| Source | Data | Frequency | File |
|---|---|---|---|
| IMF DataMapper (WEO, Fiscal Monitor) | GDP growth, inflation, unemployment, current account, debt, balances, revenue, expenditure, with projections | annual | `imf.json` |
| OECD Quarterly National Accounts | real GDP growth (y/y, q/q) | quarterly | `oecd_gdp.json` |
| BIS | CPI inflation, policy rates, nominal/real effective exchange rates | monthly | `bis_monthly.json` |
| BIS total credit | debt of households, non-financial corporations, government (% of GDP) | quarterly | `bis_credit.json` |
| Eurostat | government debt and balance (EU/EEA) | quarterly | `eurostat_gov.json` |
| ECB | euro reference exchange rates | daily | `ecb_fx.json` |
| Federal Finance Administration (GFS) | Swiss gross/net debt (IMF) by subsector and component from the balance sheets; Maastricht debt and GDP incl. forecasts | annual | `swiss_debt.json` |
| Eurostat EU-SILC | population by housing tenure (owners with/without mortgage, tenants) | annual | `eurostat_housing.json` |
| Federal Statistical Office (structural survey) | Swiss housing tenure and homeownership rate by canton, since 2019 | annual | `fso_housing.json` |
| UN Comtrade | goods trade by partner and HS chapter, gold (HS 7108) separately; refreshed weekly | annual | `trade.json` |

Each source is fetched independently. If one fails, its previous file is kept and the
failure is recorded in `docs/data/meta.json`; the dashboard flags it as stale.

## Run locally

```r
# from the project root (or open macro-dashboard.Rproj)
source("R/update_data.R")
```

Then serve `docs/` with any static server, e.g. `python3 -m http.server -d docs 8000`, and
open <http://localhost:8000>. (Opening `index.html` directly does not work: browsers block
loading the JSON files from `file://`.)

## Customise

- **Countries**: `config/countries.csv`. One row per economy with its code in each source
  (leave a cell empty if a source does not cover it) and its currency. The `groups` column
  assigns countries to the presets defined in `config/groups.csv` (max. 8 per preset).
- **IMF indicators**: add a row to `config/indicators.csv` with `source = imf` and any
  DataMapper code (list: <https://www.imf.org/external/datamapper/api/v1/indicators>). To
  show it, add an `indicatorCard(grid, "<id>")` line in the relevant tab in
  `docs/assets/app.js`.
- **Trade reporters**: `config/trade_reporters.csv` (dashboard id + UN Comtrade reporter code;
  Switzerland is 757). Each reporter adds about 30 API calls, spaced out because the keyless
  Comtrade endpoint is rate-limited; a free key in the `COMTRADE_KEY` environment variable (or
  GitHub secret) switches to the regular endpoint.
- **Other sources**: one fetch function per source in `R/fetch_*.R`; each returns the same
  structure (`freq`, `periods`, `series[indicator][country]`).

The front-end (`docs/`) is plain HTML/CSS/JavaScript with no build step and no external
libraries.
