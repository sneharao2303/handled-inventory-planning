# Claude Code Task — Run ALL co-mans together (holistic planning, not per-co-man)

Paste this whole file to Claude Code. You're in `handled-planning-tool/`. Read `CLAUDE.md` and `BUILD_SPEC.md` first. `npm test` must stay green throughout and gain new checks.

---

## The core change

Right now the tool processes **one co-man at a time**, which is wrong — it double-counts. Example of the bug: run Palmer alone and it says "buy 14,200 Camogie Compound" because Palmer's file has none — but Camogie is sitting at Elmers. The buy decision is nonsense in isolation.

**The real model (how the client's Excel works): normalize ALL co-mans' inventories, COMBINE them into one inventory picture, then net total ingredient needs against that combined on-hand.** Make the tool work this way.

So the flow becomes:

1. Upload (or demo) **all four** co-man inventory files at once: **Elmers, Bazzini, Palmer, SPG (Superior Pack Group)**.
2. Each is normalized by its own parser into the canonical `{ingredient/code → qty}` schema.
3. **Merge** all normalized inventories into one combined on-hand map, summing by ingredient code across co-mans (e.g. RM0130 on-hand = Elmers' + Bazzini's + Palmer's + SPG's).
4. Pull **opening finished-goods inventory** from the FST/Green Rabbit stand-in (see note below).
5. Run the engine once on the **combined** picture → one production plan + one buy-list.

---

## The four real co-man formats (verified from the client's actual files)

All four arrive as Excel tabs/files. In demo mode, hardcode the real samples below into `data/seed.json` under `raw_samples`. **Match ingredients by CODE, never by description** — the same RM code has different descriptions at different co-mans.

Only **ingredient rows** (codes starting `RM`, or the Elmers `IN-` compound codes) feed ingredient-need math. Packaging/carton/pouch rows (PK-*, SPM*, MC02, etc.) are normalized and kept but tagged `category:"packaging"` and excluded from ingredient needs.

### 1. Elmers — spatial grid, find-by-supplier-code (NEEDS A FIX for this file's layout)
Codes (90248B etc.) sit in the grid in blocks; each block has headers `Item | HC SKU | <orientation> | Units | Bars`. **The quantity is in the "Units" column of that block** — in the real `seed.raw_samples.elmers` it's **3 columns right** of the code, not 2 (the older demo grid was 2). **Make the parser robust: locate the quantity by finding the "Units" column header for the block, not a fixed offset.** Fall back to scanning right for the first numeric cell if no header.

Real verified values from `seed.raw_samples.elmers` (a different month's snapshot — only 3 compounds present this time):
- IN-CH302v2 (Idaho Compound) → **90,669**
- IN-MC301v2 (Stockton Compound) → **75,920**
- IN-PB303v2 (Camogie Compound) → **16,600**

(The crisp/salt ingredients aren't in Elmers' grid this snapshot — they're at the other co-mans. That's correct; flag-none, don't error.)

NOTE: the `elmers_map` uses both `IN-` codes and `90xxx` supplier codes. Match on whichever the grid carries (this file's ingredient rows use the `IN-` HC SKU in col B and the `90xxx` in col A).

### 2. Bazzini — transactional lot list, SUMIF by Hormbles code
Columns: `Item Number | Hormbles # | Item Description | Location | Bin | Lot | Qty | UOM`. The **Hormbles # is in column B (index 1)**. Many rows per item (one per lot/bin). 
**Logic:** sum `Qty` (col G, index 6) across all rows where Hormbles# (col B) matches each ingredient code. Only keep codes starting with `RM`.
Verified sample results (sum across lots): RM0130 → 2,440 · RM0137 → 129.66 · RM0125 → 11,609.83 · RM0153 → 7,773.02 (and ~14 more RM codes).

### 3. Palmer — categorized list, code-in-file, strip unit text
Columns: `Category | RMP item # | Hormbles item # | Description | On Hand`. Hormbles code in **column C (index 2)**; On Hand in **column E (index 4)** carries unit text ("19,200 lbs", "314 lbs", "24,000 ea") or "0"/"-". Category labels (Pouch/Pre-made bags/Cartons/Ingredient) appear in col A on section-header rows.
**Logic:** for each row with a Hormbles code, read On Hand, **strip "lbs"/"ea"/"cs"/commas/spaces** to a number, "-"/"0" → 0. Ingredient rows are RM0130/RM0131/RM0137.
Verified: RM0130 → 19,200 · RM0131 → 314 · RM0137 → 500.

### 4. SPG (Superior Pack Group) — item-type table, default-quantity lookup
Columns: `Item code | Item description | Item type | Expiry | Lot | Default quantity | UOM | Full pallet qty | Inventory status`. 
**Logic:** keep rows where **Item type (col C, index 2) = "Raw Material"**; read **Default quantity (col F, index 5)**. Match the item code to a Hormbles ingredient code. SPG mostly carries packaging + finished goods — only a few raw-material rows; that's expected (flag none-found as informational, not error).

---

## FST / Green Rabbit (opening finished-goods inventory) — IMPORTANT

The real FST and Green Rabbit data is **not in a file** — it's accessed via web portals (the client's file has empty FST/GR tabs and only portal logins). So **for the demo, use the `opening_inv` data already in `seed.json`** (extracted from the client's `Total Inventory OH` tab — finished-goods on-hand by SKU). Wire it as the opening-inventory source that seeds the engine's month-1 starting inventory. Add a clear note in the UI: "3PL opening inventory — demo uses Total Inventory OH stand-in (live FST/Green Rabbit portal integration is future)."

Note: this finished-goods inventory is SEPARATE from co-man raw-material inventory. Co-man inv → ingredient buy-list (what to buy). 3PL inv → supply-plan starting inventory (how much to make). Don't merge the two.

---

## What to build

### A. Parsers — `lib/parsers.js`
- Keep `parseElmers`.
- Add/finish `parseBazzini` (SUMIF by col-B Hormbles code, RM-only), `parsePalmer` (code-in-file col C + strip units), `parseSPG` (Raw Material rows, default-qty col F). Each returns `{rows:[{ingredient,code,qty,category,status}], flags}`.
- Reuse the `num()` unit-stripping helper; extend if needed.

### B. New combine step — `lib/engine.js`
Add `combineInventories(normalizedByComan)` → returns one `{ code → {qty, sources:[...]} }` map, summing qty by code across all co-mans and recording which co-mans contributed (for the "show the math" trace). Ingredient-need math runs against THIS combined map.

### C. Demo data — `data/seed.json`
Add real `raw_samples`: `elmers` (exists), `bazzini`, `palmer`, `spg` — as grids (arrays of rows) using the real sample values above. Add per-co-man code maps as needed (Bazzini/Palmer/SPG carry the Hormbles code in-file, so maps are mostly just "which codes are ingredients").

### D. UI — `public/index.html`
- Replace the single co-man selector with **all four uploaded together** (four drop zones, or one multi-file zone tagged by co-man). Demo mode loads all four real samples at once.
- Step 2 "Normalized inventory" shows the **combined** table: ingredient · total on-hand · a breakdown of which co-mans contributed · flags. This is the holistic view.
- Steps 3–4 (decisions, plan, buy-list) run once on the combined picture — unchanged logic, combined inputs.

### E. Verification — `scripts/verify.mjs`
Add checks against the REAL `seed.raw_samples` data (these are the true values in the uploaded file — a different snapshot than the older May numbers):
- Elmers parser: IN-CH302v2 (Idaho) → 90,669 · IN-MC301v2 (Stockton) → 75,920 · IN-PB303v2 (Camogie) → 16,600.
- Bazzini parser (SUMIF across lots): RM0130 → 2,440 · RM0137 → 129.66 · RM0125 → 11,609.83 · RM0153 → 7,773.02.
- Palmer parser (strip units): RM0130 → 19,200 · RM0131 → 314 · RM0137 → 500.
- **Combine step**: RM0130 combined across co-mans = Bazzini 2,440 + Palmer 19,200 = 21,640 (Elmers' grid has no RM0130 this snapshot). Assert the combine sums correctly.
- Demonstrate the fix: an ingredient present at one co-man is netted against combined on-hand, not bought spuriously per-co-man.

NOTE: the existing Elmers May checks in the current `verify.mjs` use the OLDER demo grid and different numbers (336,600 units → 5,936.61 lbs, etc.). Keep a separate "engine math" test that still uses those fixed production inputs so the engine stays verified — but the NEW co-man parser tests use the real `seed.raw_samples` values above. Don't conflate the two snapshots.

`npm test` must end with ALL CHECKS PASSED.

---

## Acceptance criteria
- All four co-man parsers work on the real sample formats; `npm test` passes with the new assertions.
- The tool runs ONCE on combined inventory — no per-co-man separate runs.
- Step 2 shows combined on-hand with per-co-man contribution breakdown + flags.
- Buy-list nets need against COMBINED on-hand (no more double-counting / phantom buys).
- 3PL opening inventory wired from the `opening_inv` stand-in, clearly labeled as demo.
- Elmers May still verifies to the client's sheet.
- `CLAUDE.md` updated with: the four co-man formats, the match-on-code rule, the combine step, the co-man-raw-inv vs 3PL-finished-inv distinction, and the FST/GR portal note.

## Don't
- Don't match ingredients on description text — match on code.
- Don't feed packaging rows into ingredient needs.
- Don't merge co-man raw-material inventory with 3PL finished-goods inventory — they serve different parts of the model.
- Don't run co-mans separately — combine first, then compute once.
- Don't silently drop unmatched codes — flag them.
- Don't change the engine's production/MRP math — only the inventory-in (normalize + combine) step changes.
