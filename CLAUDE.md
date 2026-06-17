# CLAUDE.md — context for Claude Code

Read this before making changes. It captures what this project is, what's already verified, and the domain rules you must not break.

## What this is

An ops-planning tool for consumer brands (think: a YC startup called "Handled" building this for a client called "Hormbles," a chocolate-bar brand). It replaces a manual, two-spreadsheet planning process. A planner uploads raw files; the app normalizes them, runs the supply + MRP engine, and outputs a production plan + ingredient buy-list.

The whole thing was reverse-engineered from the client's real Excel files and **verified to reproduce their numbers exactly**. `npm test` is the proof — keep it green.

## Architecture

- `public/index.html` — the current app. Zero-build, vanilla JS, loads SheetJS from CDN. The `lib/` logic is inlined into it (look for the parser/engine function bodies inside the `<script>`).
- `lib/parsers.js`, `lib/engine.js` — the **canonical, verified** logic as ES modules. The inlined copy in index.html must stay in sync with these. If you change logic, change it in `lib/` and re-inline, and re-run `npm test`.
- `data/seed.json` — real reference data (code maps, recipes, ratios, BOM, opening inventory) and `raw_samples` (real raw co-man grids for demo/testing).

## The domain model (don't break these rules)

Verified pipeline, in order:
1. **Normalize EVERY co-man's inventory.** All four co-mans arrive in different raw formats; normalize them **all** (not one at a time). **Match ingredients by CODE, never by description** — the same RM code has a different description at each co-man. Each parser returns `{rows:[{ingredient,code,qty,category,status}], flags}` and keys `code` to the canonical Hormbles code so the combine step can sum across co-mans. Always surface `flags` — never silently drop an unmatched code.
   - `parseElmers` — spatial grid; finds each ingredient by its 90xxx supplier code (or IN-/RM HC SKU) and reads the quantity under the block's **"Units"/"lbs" header** (robust to the offset: real snapshot is 3 cols right, older demo was 2; falls back to scanning right for the first numeric cell).
   - `parseBazzini` — transactional lot list; **SUMIF** col G (qty) over all rows whose col B Hormbles# matches each code, **RM codes only**.
   - `parsePalmer` — categorized list; Hormbles code in col C, On Hand in col E carrying unit text ("19,200 lbs", "24,000 ea", "-"/"0") → strip to a number.
   - `parseSPG` — item-type table; keep rows where col C = "Raw Material", read col F default quantity. SPG mostly carries packaging + finished goods, so "no ingredient raw-materials" is an informational flag, not an error.
   - Only **ingredient rows** (codes starting `RM`, or Elmers `IN-` compound codes) feed ingredient-need math. Packaging/carton/pouch rows (PK-*, SPM*, MC02, …) are normalized and kept but tagged `category:"packaging"` and excluded from needs.
1b. **Combine inventories.** `combineInventories(normalizedByComan)` merges all co-mans into one `{code → {qty, category, sources:[{coman,qty}]}}` map, **summing qty by code across co-mans** and recording which co-mans contributed (for the "show the math" trace). **All ingredient-need netting runs against THIS combined map — never one co-man at a time.** Per-co-man netting double-counts and invents phantom buys (e.g. "buy 14,200 Camogie" when Camogie is sitting at Elmers). `combinedOnhandByName(combined, ingredient_map)` re-keys the combined on-hand by the recipe ingredient name (via `seed.ingredient_map`: code → recipe name) so the buy-list can net needs (keyed by name) against combined on-hand (keyed by code).
2. **Production.** `New production units = pallets_to_run × minis_per_pallet`. Pallets is a HUMAN input (was a hard-typed "11" in their sheet). minis_per_pallet comes from refprod (e.g. 30,600 = 850/case × 36 cases/pallet). **Pallet count must never silently default to 1** — use the suggestion (pre-filled as the visible default, with its months-of-supply reasoning) or leave it unset (production 0 + a "⚠ set pallets" prompt), but never a hard 1. The months-of-supply suggestion offsets demand by **finished** sellable stock on hand only — *not* WIP (WIP is the production itself; offsetting by it collapsed the suggestion to 1 and silently produced tiny numbers). The holistic demo at 11 pallets must reproduce **336,600 units / 5,936.61 lbs** and net against combined inventory (Cocoa combined 1,042 → buy 0). This is locked by a `verify.mjs` check (section C).
3. **Production lbs** = `units × grams_per_mini ÷ 453.59237`.
4. **Ingredient needs** = `production_lbs × recipe_pct × (1 + scrap_pct)`, summed per ingredient, filtered to the co-man `location`.
5. **Qty Remaining** = `BOM_Inv + Actuals − Qty_Needed + Qty_to_Purchase` — where `BOM_Inv` is the **combined** on-hand.

### Co-man raw inventory vs 3PL finished-goods inventory — keep them SEPARATE
Two different inventories serve two different parts of the model — **do not merge them**:
- **Co-man raw-material inventory** (Elmers/Bazzini/Palmer/SPG) → feeds the **ingredient buy-list** (what to buy). Combined via `combineInventories`.
- **3PL finished-goods inventory** (FST / Green Rabbit) → seeds the **supply plan's month-1 starting inventory** (how much to make). Read via `parse3PL` / `opening_inv`.

### FST / Green Rabbit are PORTALS, not files
The real FST and Green Rabbit data is **not in a file** — it lives in web portals (the client's file has empty FST/GR tabs with only portal logins). For the demo, use the `opening_inv` data in `seed.json` (extracted from the client's `Total Inventory OH` tab) as the opening finished-goods stand-in, clearly labeled in the UI. Live portal integration is future.

### Critical gotcha — SKU code mismatch
The supply side and the recipe/MRP side use **different SKU codes for the same mini**:
- Supply/BOM side: `MBMC4001-WIP`, `MBSF4002-WIP`
- Recipe/production side: `MCM1001-WIP`, `MSF1002-WIP`

The engine keys production by the **recipe-side** codes (`MCM1001-WIP`). If you wire BOM/demand (which use `MBMC4001-WIP`) into production, you MUST bridge the codes or ingredient needs silently come out 0. This is a known real-world data issue; the canonical mapping is a question still open with the client. The UI uses a small `WIP_BRIDGE` (`MCM1001-WIP→MBMC4001-WIP`) to pull 3PL opening inventory for the pallets suggestion — flagged in the UI as a known bridge.

### Transparency layer — every number is inspectable
Every output number must be inspectable (click-to-expand derivation) and each step (Normalize → Combine → Produce → Buy-list) has a plain-English "what's happening here" note tied to the run's real numbers. Traces come from the engine `explain*` functions (`explainProduction`, `explainCombined`, `explainNeed`, `explainBuyRow`), never a separate recomputation, so they can't drift from the result — `verify.mjs` section (D) asserts each traced value equals the canonical engine output. A run-independent "How this works" panel states the method once. Decision reasoning (suggested vs manual + the `why`) persists into the final buy-list. This transparency layer is how the client verifies the tool against their own process. When adding any displayed number, add/extend an `explain*` helper in `lib/engine.js` (re-inline it) rather than formatting the math inline.

## The four human decisions (Path B + manual)

These are NOT yet computable — the rules aren't known. The app suggests a value WITH reasoning, and lets the user accept or override. Keep this pattern; build any new decision the same way so a manual field can later become suggested-and-approved without a redesign.

| Decision | Suggestion basis (placeholder) | Open question to resolve the rule |
|---|---|---|
| Pallets to run | months-of-supply target | what target / rule does the planner use? |
| Other Volume | carry-forward last month | is there a samples/gifting source? |
| Qty to Purchase | shortfall rounded up to 100 | buffer? MOQ? pallet multiple? lead time? |
| Actuals | default 0 | is it in-transit stock we can source from tracking? |

## Verification — keep it green

`npm test` runs `scripts/verify.mjs`, which runs the **real `lib/` parsers + engine** against `seed.json` in four groups (A–D):

**(A) Parser + combine tests** — against the real `seed.raw_samples` snapshot (a *different* month than the May engine scenario; don't conflate the two):
- Elmers: Idaho (IN-CH302v2) 90,669 · Stockton (IN-MC301v2) 75,920 · Camogie (IN-PB303v2) 16,600.
- Bazzini (SUMIF lots): RM0130 2,440 · RM0137 129.66 · RM0125 11,609.83 · RM0153 7,773.02.
- Palmer (strip units): RM0130 19,200 · RM0131 314 · RM0137 500.
- Combine: RM0130 per-source = Bazzini 2,440 + Palmer 19,200 (the task's stated subtotal 21,640) **plus** Elmers 14,704 — this snapshot's Elmers grid DOES carry RM0130, so the honest combined total is **36,344**. The combine sums by code across all co-mans.
- The fix: Camogie need (14,172.17) nets to **buy 0** against combined on-hand (16,600 at Elmers), vs a phantom ~14,200 buy if Palmer were run alone.

**(B) Engine math tests** — fixed verified May scenario (unchanged engine):
- MC mini: 11 pallets → 336,600 units → 5,936.61 lbs
- Elmers needs: Camogie 14,172.17 · Idaho 5,713.99 · Plain Milk Crisp 2,951 · Cocoa Whey Crisp 833.66 · Encap Salt 185.63 · Stockton 5,877.24
- Cocoa Whey Crisp shortfall 567.66; remaining after buying 800 = 232.34

**(C) Full holistic pipeline @ 11 pallets** — combine all 4 co-mans then produce, asserting 336,600 units / 5,936.61 lbs, the combined on-hand (Cocoa 1,042; Plain Milk Crisp 36,344), and that combined stock covers every need (all buys 0).

**(D) Transparency** — each `explain*` trace value equals the canonical engine value (production, combined, needs, buy-row), so the displayed math can never drift from the result.

If any of these change, you broke something. Fix it before moving on.

## Roadmap (see BUILD_SPEC.md for detail)

Next steps to make it the full hosted product:
1. Migrate to **Next.js + Prisma/SQLite** (BUILD_SPEC has the schema, routes, screens).
2. Real DB-backed config UI for code maps + recipes (so onboarding a new co-man/ingredient needs no code change).
3. ~~Wire all four co-man uploads + combine into one inventory~~ **DONE** — UI uploads all four together, combines by code, and plans once on the combined picture. Still future: live FST/Green Rabbit 3PL **portal** parsing (currently `opening_inv` stand-in).
4. Save monthly runs (inputs + decisions + outputs) for history and plan-vs-actual.
5. Later: replace uploads with live integrations (Cin7, Shopify, Modis, email/PDF). Engine + UI stay identical.

## Style / approach
- Don't over-engineer. The static app proves the concept; grow it deliberately.
- Every output number should be traceable to its inputs ("show the math"). That's the trust mechanism for users.
- The parsers/engine are the IP. Treat them as a tested library; change them only with the test suite as a guard.
