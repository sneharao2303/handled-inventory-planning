# Claude Code Task — Add Palmer co-man support (end-to-end, with demo + verification)

Paste this whole file to Claude Code as the task. It assumes you're in the `handled-planning-tool/` project. Read `CLAUDE.md` and `BUILD_SPEC.md` first — they define the domain rules you must not break, and `npm test` must stay green throughout.

---

## Goal

Add **Palmer** as a fully working co-man, end-to-end: real normalization of Palmer's raw inventory format → into the engine → producing the production plan and ingredient buy-list, with a **demo mode** (preloaded real Palmer data) and a **verification test** that proves the normalized numbers are correct. Do all the normalization + backend logic from scratch — don't fake it.

This mirrors what already exists for Elmers. Use the Elmers implementation as the pattern, but Palmer's input format is different (described precisely below).

---

## What Palmer sends us (the real input)

Palmer emails an inventory file (we'll treat it as an uploaded Excel/CSV; in the demo, hardcode it as the sample below). Real example, "as of 5/8":

| RMP item # | Hormbles item # | Description | On Hand |
|---|---|---|---|
| 9062505 | PK-WPMMC | MCF Mini pouch | 226 lbs |
| 9062605 | PK-WPMPB | PB Mini pouch | - |
| 9063005 | PK-WPMSF | Salted Fudge Mini pouch | 291 lbs |
| 9062705 | SPMMC | MCF pre-made bags | 24,000 ea |
| 9062805 | SPMPB | PB pre-made bags | 35,000 ea |
| 9062905 | SPMSF | Salted Fudge pre-made bags | 43,700 ea |
| 9062701 | MC02 | Unprinted RSC 6pk | 42,418 ea |
| 9062501 | Bulk Carton | Unprinted Bulk carton | 1,455 ea |
| 942107/ 9848 | RM0130 | Milk Protein Crisp 40# case | 19,200 lbs |
| 942207/ 9849 | RM0131 | Cocoa Protein Crisp 40# case | 314 lbs |
| 942307/ 9847 | RM0137 | Pretzel Salt 50# case | 500 lbs |

### Critical structural facts about Palmer's format (these drive the parser)

1. **The Hormbles item # is IN the file (column 2).** Unlike Elmers (where we had to map Hormbles codes ↔ Palmer supplier codes via a separate table), Palmer already labels each row with our code. So normalization is a **direct read**, not a fuzzy code lookup. Match on the Hormbles item # column.
2. **Quantities carry unit text** — "226 lbs", "24,000 ea", "500 lbs". You MUST strip the unit text and commas to get a number. A dash "-" means 0 / none.
3. **Rows are grouped by category** — Pouch, Pre-made bags, Cartons, Ingredient. Only the **Ingredient** rows (RM-codes: RM0130, RM0131, RM0137) feed the MRP ingredient buy-list. The pouch/bag/carton rows are packaging — keep them in the normalized output (flagged as packaging) but they don't enter ingredient-need math.
4. **The same RM code can have a different DESCRIPTION than at another co-man.** At Palmer, RM0130 is "Milk Protein Crisp"; at Elmers the equivalent is "Plain Milk Crisp". **Match on code (RM0130), never on description text.** This is a real gotcha — the canonical ingredient identity is the RM code.
5. There may be a known UOM-mismatch case (some packaging is reported in lbs but the BOM wants a wrapper/each count) — for now, flag those rows for manual entry rather than guessing the conversion. The ingredient RM-rows above are clean (all in lbs), so they normalize directly.

---

## What to build

### 1. Parser — `parsePalmerV2(grid, codeMap)` in `lib/parsers.js`

There's an older `parsePalmer` written for a different (messier) Palmer layout. Write a new `parsePalmerV2` for THIS real format (or replace the old one — your call, but keep `npm test` green and note it in CLAUDE.md):

- Input: `grid` = array-of-rows from `XLSX.utils.sheet_to_json(sheet, {header:1})`; `codeMap` = the list of Hormbles ingredient codes we care about (RM0130, RM0131, RM0137 …) with their canonical descriptions.
- Logic: find each row by its **Hormbles item # column**, read the **On Hand** column, **strip unit text** ("lbs"/"ea"/"cs"/commas/spaces) to a number, treat "-" as 0.
- Return `{ rows: [{ ingredient, code, qty, category, status }], flags: [...] }` — same shape as the other parsers. `category` = "ingredient" | "packaging". Flag any code in the map not found in the file, and any UOM-mismatch row.
- **Surface flags in the UI — never silently drop a row.**

Reuse the existing `num()` unit-stripping helper if it already handles "lbs"/"ea"/commas; extend it if needed.

### 2. Demo data — add Palmer to `data/seed.json`

Add a `raw_samples.palmer_v2` entry containing the real sample table above as a grid (array of rows), and a `palmer_map` listing the ingredient codes we extract (RM0130, RM0131, RM0137) with canonical descriptions. Use the real "as of 5/8" values.

For the **FST and Green Rabbit** opening-inventory demo inputs, use the `opening_inv` data already in `seed.json` (it was extracted from the client's Total Inventory OH tab — that's our stand-in for the 3PL exports until we get real FST/Green Rabbit sample files). Wire it as the opening-inventory source so the demo is complete.

### 3. UI — make Palmer selectable

In `public/index.html` (and keep `lib/` as the source of truth, re-inline):
- The co-man dropdown already lists Palmer. Wire it so selecting Palmer + uploading (or using demo) runs `parsePalmerV2`.
- Demo mode: if no file is uploaded and Palmer is selected, use `raw_samples.palmer_v2`.
- Show the normalized table with the category column and any flags.

### 4. Verification — extend `scripts/verify.mjs`

Add a Palmer section that asserts the parser reproduces the real normalized values:
- RM0130 (Milk Protein Crisp) → **19,200**
- RM0131 (Cocoa Protein Crisp) → **314**
- RM0137 (Pretzel Salt) → **500**
- PK-WPMPB (the "-" row) → **0**
- packaging rows (e.g. SPMMC) → categorized as "packaging", not fed to ingredient needs

Keep all existing Elmers checks passing. `npm test` must end with ALL CHECKS PASSED.

---

## Acceptance criteria

- `npm test` passes, including new Palmer assertions (RM0130=19,200; RM0131=314; RM0137=500; dash=0).
- Selecting Palmer in the UI and running demo mode shows the normalized Palmer inventory with categories and zero unmatched flags for the ingredient rows.
- The Palmer ingredient on-hand flows into the buy-list math exactly like Elmers' does (net vs need).
- Elmers still works and still matches the client's sheet (336,600 units → 5,936.61 lbs; Cocoa Whey Crisp buy logic intact).
- Update `CLAUDE.md` with Palmer's format notes (code-in-file, unit-text stripping, match-on-code-not-description, category filtering) so future work knows the rules.

## Don't

- Don't match ingredients on description text — match on the RM/Hormbles code.
- Don't feed packaging rows (pouches/bags/cartons) into ingredient-need math.
- Don't silently drop unmatched or UOM-mismatch rows — flag them.
- Don't rewrite the engine; Palmer only changes the *normalization* (data-in) step. The production/MRP math is identical once inventory is normalized.
