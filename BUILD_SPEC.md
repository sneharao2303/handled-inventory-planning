# Handled Planning Tool — Build Spec (for vibe-coding into a hosted app)

*Paste this spec, plus the two verified logic files (`lib/parsers.js`, `lib/engine.js`) and `seed.json`, into your vibe-coding tool (Bolt / Replit / v0 / Cursor) to generate the full hosted application. The parsers and engine are already tested against Hormbles' real May data and reproduce their numbers exactly — do not rewrite them, wire the app around them.*

---

## What this app does

A consumer-brand ops planning tool. A planner uploads the raw files they already receive (co-man inventory, demand plan, 3PL inventory), the app normalizes the mess, runs the supply + MRP math, and produces a **production plan** and an **ingredient buy-list**. For the four decisions that aren't yet rule-based, it **suggests a value with reasoning and lets the planner accept or override**.

It reproduces, automatically, what Hormbles' team does by hand across two Frankenstein spreadsheets.

## Recommended stack (easiest to host + vibe-code)

- **Next.js (App Router) + React** — one codebase, frontend + API routes together.
- **SQLite via Prisma** — zero external DB to provision; file-based, deploys anywhere. (Swap to Postgres later for multi-user.)
- **SheetJS (`xlsx`)** — parse uploaded `.xlsx`/`.csv` in an API route.
- Deploy target: **Replit or Vercel**, one click.

## Data model (Prisma schema)

```prisma
model CodeMap {        // Hormbles ingredient <-> co-man supplier code
  id        Int    @id @default(autoincrement())
  coman     String // "elmers" | "bazzini" | "palmer" | "spg"
  hcode     String // Hormbles ingredient code/name
  desc      String
  supcode   String // co-man's code (for elmers/palmer); for bazzini may be comma list
  manualUOM Boolean @default(false) // palmer rows needing lbs->wrapper conversion
}

model Recipe {         // BOM: which ingredients + % + scrap per producing SKU
  id         Int    @id @default(autoincrement())
  sku        String
  ingredient String
  loc        String  // co-man location this recipe line applies at
  pct        Float
  scrap      Float
}

model RefProduct {     // minis per pallet, grams, etc. per WIP/finished SKU
  id           Int    @id @default(autoincrement())
  sku          String @unique
  minisPallet  Int
  grams        Float
  perCase      Int?
  casesPallet  Int?
}

model Bom {            // finished SKU -> WIP -> minis per unit
  id       Int    @id @default(autoincrement())
  finished String
  wip      String
  minis    Int
}

model Run {            // a saved monthly planning run
  id         Int      @id @default(autoincrement())
  month      String
  createdAt  DateTime @default(now())
  inputsJson String   // normalized inventory, demand, schedules
  decisionsJson String // the 4 human decisions (mode + value each)
  outputsJson String   // production + buy-list
}
```

Seed all reference tables (CodeMap, Recipe, RefProduct, Bom) from the provided `seed.json` on first run. `seed.json` keys: `elmers_map`, `bazzini_map`, `recipes`, `refprod`, `bom`, `opening_inv`, `raw_samples` (real demo data so the app works before any upload).

## The normalization logic — USE THE PROVIDED `lib/parsers.js`

Already written and **verified against Hormbles' real file** (7/7 Elmers ingredients reproduce exactly). It exports:
- `parseElmers(grid, codeMap)` — find-by-supplier-code in a spatial grid; qty 2 cols right.
- `parseBazzini(grid, codeMap)` — SUMIF across lot rows by code.
- `parsePalmer(grid, codeMap)` — VLOOKUP + strip "lbs/ea/cs" text; flags 2 UOM-mismatch rows for manual entry.
- `parseSPG(grid, codeMap)` — default-quantity lookup.
- `parse3PL(grid, opts)` — generic finished-goods reader for FST / Green Rabbit.

Each returns `{ rows: [{ingredient, code, qty, status}], flags: [...] }`. **Surface the flags in the UI — never silently drop an unmatched code.**

Grid input = `XLSX.utils.sheet_to_json(sheet, { header: 1 })` (array of row-arrays).

## The planning logic — USE THE PROVIDED `lib/engine.js`

Already written and verified (reproduces 336,600 units → 5,936.61 lbs; Cocoa Whey Crisp need 833.66). Exports:
- `productionLbs({palletsByWip, refprod, barsLbs})` → production pounds per SKU.
- `ingredientNeeds({prodLbs, recipes, location})` → lbs of each ingredient (recipe × scrap).
- `buyList({needs, onhand, actuals, buyDecisions})` → the netted buy-list.
- `suggestPallets`, `suggestOtherVolume`, `suggestBuy`, `suggestActuals` → Path-B suggestions, each returns `{value, why}`.

## Screens (frontend flow)

1. **Upload** — drop zones per source: co-man inventory (with a co-man selector: Elmers/Bazzini/Palmer/SPG), demand plan, FST, Green Rabbit. Parse in an API route via SheetJS → store normalized result. Preloaded demo data lets the user proceed with no files.

2. **Review normalized inventory** — table of ingredient × on-hand, with a **flags panel** for anything unmatched. Editable (a planner can fix a value). This is the trust screen.

3. **Confirm decisions** — for each of the four (pallets per WIP, Other Volume, purchases where short, Actuals): show the **suggested value + reasoning**, an **Accept** button, and an **Enter manually** field. Persist mode (`suggest`/`manual`) + value.

4. **Plan & buy-list** — KPIs (units, lbs, # to buy), production table, buy-list table with each buy tagged suggested/manual, and a **"show the math" trace** on every number (e.g. `11 pallets × 30,600 × 8g ÷ 453.6`). **Export to Excel** (SheetJS `writeFile`).

5. **Config** (settings) — edit CodeMaps, Recipes, RefProduct. This is what lets them onboard a new ingredient/co-man without a rebuild.

## API routes

- `POST /api/parse` — body: file + coman/type → returns `{rows, flags}` using the right parser.
- `GET/POST /api/config/*` — CRUD for code maps + recipes.
- `POST /api/run` — body: normalized inputs + decisions → returns `{production, buyList}` via the engine; saves a `Run`.
- `GET /api/runs` — history.

## The four human decisions (Path B + manual)

| Decision | Suggestion basis | Manual override | Becomes automatic when… |
|---|---|---|---|
| Pallets to run | months-of-supply target | yes | we learn their target / rule |
| Other Volume | carry-forward last month | yes | a samples/gifting source exists |
| Qty to Purchase | shortfall rounded up | yes | we learn John's buffer/MOQ rule |
| Actuals | default 0 | yes | in-transit tracking is connected |

Build the decision component so a manual field can later switch to suggested-and-approved **without redesign** — same UI, smarter default.

## Verification (must hold after build)

With the embedded Elmers May demo data + 11 pallets MC mini + bars (BPB3003 5,291.09 lbs, BPB5003 9,866.30 lbs):
- MC mini production = **336,600 units → 5,936.61 lbs**
- Elmers ingredient needs: Camogie 14,172.17 · Idaho 5,713.99 · Plain Milk Crisp 2,951 · Cocoa Whey Crisp 833.66 · Encap Salt 185.63 · Stockton 5,877.24
- Buy-list: Cocoa Whey Crisp short (266 on hand) → suggest/confirm a buy; everything else 0.

If those numbers come out, the wiring is correct.

## Future (after v1) — live integrations

Replace the **upload** step with **auto-fetch**: Cin7 API, Shopify, FST/Insight portal, Green Rabbit, Modis, and email/PDF parsing for co-man feeds. The engine, decisions, and UI stay identical — only the data-in step changes. That's why upload-first is the right MVP: same app, manual front door.
