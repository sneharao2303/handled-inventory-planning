# CLAUDE.md — context for Claude Code

Read this before making changes. It captures what this project is, what's already verified, and the domain rules you must not break.

## What this is

An ops-planning tool for consumer brands (think: a YC startup called "Handled" building this for a client called "Hormbles," a chocolate-bar brand). It replaces a manual, two-spreadsheet planning process. A planner uploads raw files; the app normalizes them, runs the supply + MRP engine, and outputs a production plan + ingredient buy-list.

The whole thing was reverse-engineered from the client's real Excel files and **verified to reproduce their numbers exactly**. `npm test` is the proof — keep it green.

## App shell — landing dashboard routes to two workflows

App has a landing dashboard routing to two workflows: Inventory Planning (real, built) and Procurement (demo, faked backend — no real Cin7/email/API). Procurement flow: trigger (MRP-recommendation mock OR manual entry) → PO draft form (placeholder fields) → status pipeline (PO Created → Sent to Supplier → Inbound Tracking → Received), with mock POs advanceable by click. Procurement is a front-end demo of the vision; keep it separate from inventory logic. In `public/index.html` the three top-level views are `#landing`, `#inventoryApp` (wraps the existing stepper + `.wrap`), and `#procurementApp`; `showView()` swaps them and the logo returns to landing. All procurement state is mock data in the `<script>` (`pos`, `MRP_REC`, `PROC_STAGES`) — it never touches the parsers/engine or the verified `npm test` path.

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

### FST + Green Rabbit (3PL) → opening inventory
FST + Green Rabbit are the two 3PL warehouses (retail + DTC). Their exports share one format: **SKU Code in col B (index 1), Qty (eaches) in col E (index 4)** (cases/sleeves are informational — never sum them); the warehouse's own SKU is col F. The header row isn't fixed (GR starts ~row 5, FST ~row 4), so `parse3PL` **detects** it by finding "SKU Code". Opening inventory = **SUMIF eaches by SKU across both** (`combineOpeningInventory`) — this reproduces the client's `Total Inventory OH` tab; verified **BCM3001 = GR 23,988 + FST 247,608 = 271,596** (verify.mjs section E). This finished-goods inventory feeds the supply plan's starting inventory and is **SEPARATE** from co-man raw-material inventory. `parse3PL` handles both warehouses (`parseFST`/`parseGreenRabbit` are thin wrappers); a 3PL code map (warehouse SKU → Hormbles SKU) supports exports that only carry the warehouse's own SKU, flagging any unresolved SKU rather than dropping it.

**Green Rabbit and FST exports have MULTIPLE rows per SKU** — `parse3PL` must SUM eaches across all matching rows, not take the first (it does). The demo seed must contain the **COMPLETE** grids (GR 32 rows, FST 29 rows) or the cross-check will (correctly) flag missing-row divergences — that's exactly the bug an earlier incomplete seed caused. All finished-goods SKUs reconcile to Total Inventory OH when complete (e.g. BMC5001 = FST 161,280 + GR 60,120 = 221,400; BSF3002 = 237,996; BPB5003 = 62,064; BPB3003 = 58,188; BCM3001 = 271,596). The only `opening_inv` SKUs NOT covered by 3PL are the WIP mini codes (`MBMC4001-WIP`, `MBSF4002-WIP`) — WIP lives at the factory, not the shipping warehouses, so it's served by the per-SKU `openingQty` fallback and is correctly outside the cross-check (verify.mjs section G asserts 0 divergences).

**Opening finished-goods inventory (FST+GR) must show finished-goods SKUs only** — the raw 3PL exports also carry packaging (`PK-*`, `HC*`) and junk/non-SKU rows ("Wafer S", "Double-", "14 BOXE", "BB101"). `classifyOpeningSku(sku, finishedGoodsSkus(seed))` groups each into finished / packaging / unknown for display: packaging and junk are filtered out of the finished-goods table (with a visible hidden-count note, never silently dropped), and zero-stock real SKUs (e.g. BCC3004, BVAR200x) are collapsed behind a "show N zero-stock SKUs" toggle. Real-but-zero bars are kept via product-family prefix match (BCC3004→"BCC", BVAR200→"BVAR") so they survive while look-alike junk (BB101→"BB") is rejected. **Filtering is display-only — the combine/reconciliation math is unchanged** (the combine still sums every row; cross-check still 0 divergences; BCM3001 = 271,596). Same finished-vs-packaging distinction as the co-man side.

Opening inventory uses a **3-tier source priority** (`resolveOpeningInventory` in `lib/engine.js`): (1) uploaded FST/GR files, (2) demo FST/GR samples, (3) preloaded `opening_inv` (Total Inventory OH stand-in) as final fallback. **The tool never breaks or shows zero/empty opening inventory for missing 3PL data** — it falls through to `opening_inv`. The UI shows the active source ("computed from FST + Green Rabbit uploads" / "demo (FST + Green Rabbit sample data)" / "preloaded Total Inventory OH stand-in (no 3PL data provided)"); when FST+GR are used (tier 1 or 2) a quiet per-SKU **cross-check** compares the computed total to the `opening_inv` reference and surfaces an inline warning only on divergence (verified BCM3001 = 271,596 — match). A separate per-SKU fallback still applies inside `openingQty` for SKUs the exports don't carry (e.g. the demo 3PL sample has bar SKUs, not the MC mini). Keep `opening_inv` in `seed.json` — it is both the final fallback and the cross-check reference. Live portal integration is still future — for now upload the downloaded exports.

### Upload — two independent sections (co-man vs 3PL)
The upload step has **two independent sections**:
- **Section 1 · Co-man inventory** — toggle between **(A) separate files** per co-man (Elmers/Bazzini/Palmer/SPG) and **(B) one combined workbook** whose tabs are the co-mans. Combined mode routes each tab by name (`routeTabName` — substring, case-insensitive): elmer→Elmers, bazzini→Bazzini, palmer→Palmer, superior/spg/pack→SPG. **CO-MAN TABS ONLY:** `routeWorkbookTabs` buckets any FST/Green Rabbit tab found in the workbook into `threePL` and **ignores it here** (surfaced as "FST/GR found but ignored — upload separately"), so 3PL is never pulled from the co-man workbook (no double-count). **Skip-patterns (portal/login/note/…) are checked FIRST** so "FST and GR portal logins" (contains substring "fst") is skipped, not routed. Missing co-mans are flagged. Both A/B produce **identical co-man combined inventory**.
- **Section 2 · 3PL finished-goods inventory (FST + Green Rabbit)** — **ALWAYS uploaded separately**, in both modes (downloaded from their portals — InSight, etc.). Feeds opening finished-goods inventory via the 3-tier fallback (uploaded FST/GR → demo samples → `opening_inv` stand-in). `normalizeOpening` is **mode-independent** — the co-man toggle never affects it.

`routeWorkbookTabs` returns `{routed (co-man only), detected, threePL, skipped, duplicates, missing}`; routed grids feed the **same** parsers + combine + engine as separate files (verify.mjs section J). Combined co-man demo = the per-co-man `raw_samples` assembled into tabs (plus stray FST/GR + portal tabs that demonstrate the ignored-3PL behavior).

### Critical gotcha — SKU code mismatch
The supply side and the recipe/MRP side use **different SKU codes for the same mini**:
- Supply/BOM side: `MBMC4001-WIP`, `MBSF4002-WIP`
- Recipe/production side: `MCM1001-WIP`, `MSF1002-WIP`

The engine keys production by the **recipe-side** codes (`MCM1001-WIP`). If you wire BOM/demand (which use `MBMC4001-WIP`) into production, you MUST bridge the codes or ingredient needs silently come out 0. This is a known real-world data issue; the canonical mapping is a question still open with the client. The UI uses a small `WIP_BRIDGE` (`MCM1001-WIP→MBMC4001-WIP`) to pull 3PL opening inventory for the pallets suggestion — flagged in the UI as a known bridge.

### Transparency layer — every number is inspectable
Every output number must be inspectable (click-to-expand derivation) and each step (Normalize → Combine → Produce → Buy-list) has a plain-English "what's happening here" note tied to the run's real numbers. Traces come from the engine `explain*` functions (`explainProduction`, `explainCombined`, `explainNeed`, `explainBuyRow`), never a separate recomputation, so they can't drift from the result — `verify.mjs` section (D) asserts each traced value equals the canonical engine output. A run-independent "How this works" panel states the method once. Decision reasoning (suggested vs manual + the `why`) persists into the final buy-list. This transparency layer is how the client verifies the tool against their own process. When adding any displayed number, add/extend an `explain*` helper in `lib/engine.js` (re-inline it) rather than formatting the math inline.

### Purchases & Actuals decisions + editable buy-list
Purchases (decision 3) and Actuals (decision 4) use the **same accept / enter-manually pattern as Other Volume**, per ingredient: default 0, with a manual override allowed **even at 0 shortfall** (the planner may know an upcoming order). A manual Actual nets into combined on-hand via the engine's `buyList({actuals})`, reducing what's needed. The buy-list "To buy" column is **inline-editable** and is the **SAME value** as decision 3 — `decisions.buy[ingr]` is the single source of truth; editing either writes that one decision (mode: manual) and `runPlan()` recomputes Remaining live. (Note: `runPlan` honors a manual buy regardless of shortfall — do not re-add a `need-have>0.5` guard around the manual branch.) Cocoa Whey Crisp carries a reusable "known manual value / open question" annotation (`SEED.known_manual_buys`): real value **800** (Tom, manual); the tool computes 0 because combined on-hand (1,042) covers the need (834); open question = how 800 is derived (buffer / MOQ / pallet-or-case multiple / lead time) — pending Hormbles. The 800 is a note + optional manual entry, **never hardcoded into the math**.

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

**(D) Transparency** — each `explain*` trace value equals the canonical engine value (production, combined, needs, buy-row, opening), so the displayed math can never drift from the result.

**(E) 3PL opening inventory** — `parse3PL` on FST + Green Rabbit (SUMIF eaches by SKU, header auto-detected) and `combineOpeningInventory` reproduce the client's Total Inventory OH: GR BCM3001 23,988 · FST BCM3001 247,608 · combined **271,596** (== the `opening_inv` stand-in). Also checks the code-map translation + unresolved-SKU flag, and that opening (finished-goods) inventory holds no raw-material codes (kept separate).

**(F) Opening-inventory source selection** — `resolveOpeningInventory` 3-tier priority: demo & uploads tiers compute BCM3001 = 271,596 with a matching cross-check; the no-3PL-data tier falls back to `opening_inv` (BCM3001 still resolves, map non-empty, no crash); a bent reference makes the cross-check report divergence (match=false) without blocking the run.

**(G) 3PL reconciliation** — with the COMPLETE GR (32 rows) + FST (29 rows) grids, every finished-goods SKU the exports carry reconciles to its Total Inventory OH reference: **0 divergences**. The 4 previously-diverging SKUs now match (BMC5001 221,400 · BSF3002 237,996 · BPB5003 62,064 · BPB3003 58,188); BCM3001 271,596 unchanged.

**(H) 3PL display filter** — `classifyOpeningSku` groups the 28 combine SKUs into 18 finished / 6 packaging / 4 junk; the finished-goods table excludes packaging (PK-*/HC*) and junk (Wafer S, Double-, 14 BOXE, BB101) while keeping real-but-zero bars (BCC3004, BVAR200). Filter is display-only: combine still carries all 28 SKUs and BCM3001 stays 271,596.

**(I) Buy/Actuals edit** — `buyList` honors a manual buy at 0 shortfall (Cocoa 800 → remaining 1,008.34) and nets manual actuals into on-hand (+100 → remaining 308.34); covered default stays buy 0 / remaining 208.34. Confirms the editable "To buy" + per-ingredient accept/manual behavior at the engine-contract level, and that `known_manual_buys` carries Tom's 800 + the open question.

**(J) Combined CO-MAN workbook** — `routeWorkbookTabs` routes ONLY the 4 co-man tabs; stray FST/Green Rabbit tabs are bucketed into `threePL` (not in `routed`, so 3PL is never pulled from the workbook → no double-count); "FST and GR portal logins" is skipped (skip-pattern beats the "fst" substring); missing co-mans flagged. Routed grids parse to the same values (Idaho 90,669 etc.); combined-mode co-man combine equals separate-mode (RM0130 36,344); 3PL opening BCM3001 = 271,596 from the separate FST/GR source alone.

If any of these change, you broke something. Fix it before moving on.

## Roadmap (see BUILD_SPEC.md for detail)

Next steps to make it the full hosted product:
1. Migrate to **Next.js + Prisma/SQLite** (BUILD_SPEC has the schema, routes, screens).
2. Real DB-backed config UI for code maps + recipes (so onboarding a new co-man/ingredient needs no code change).
3. ~~Wire all four co-man uploads + combine into one inventory~~ **DONE**. ~~FST/Green Rabbit 3PL parsing~~ **DONE** — `parse3PL` + `combineOpeningInventory` read the two warehouse exports (file upload) and reproduce Total Inventory OH. Still future: swap the file upload for **live portal API** calls (same parser interface).
4. Save monthly runs (inputs + decisions + outputs) for history and plan-vs-actual.
5. Later: replace uploads with live integrations (Cin7, Shopify, Modis, email/PDF). Engine + UI stay identical.

## Style / approach
- Don't over-engineer. The static app proves the concept; grow it deliberately.
- Every output number should be traceable to its inputs ("show the math"). That's the trust mechanism for users.
- The parsers/engine are the IP. Treat them as a tested library; change them only with the test suite as a guard.
