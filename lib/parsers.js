// lib/parsers.js
// Co-man inventory normalizers. Each takes a raw 2-D grid (array of rows, from SheetJS sheet_to_json header:1)
// plus a code map, and returns { rows: [{ingredient, code, qty, category, status}], flags: [...] }.
//
// THE GOLDEN RULE: match ingredients by CODE, never by description — the same RM code has a
// different description at every co-man. `code` on each returned row is the canonical Hormbles
// code (RM0130, IN-CH302v2, …) so combineInventories() can sum the same ingredient across co-mans.
//
// Only ingredient rows (codes starting `RM`, or Elmers `IN-` compound codes) feed ingredient-need
// math. Packaging/carton/pouch rows (PK-*, SPM*, MC02, …) are normalized and kept but tagged
// category:"packaging" and excluded from needs. Never silently drop an unmatched code — flag it.

// Helper: scan a grid for an exact cell value, return [row, col] (0-indexed) or null.
function findCell(grid, value) {
  const v = String(value).trim();
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r] || []).length; c++) {
      const cell = grid[r][c];
      if (cell != null && String(cell).trim() === v) return [r, c];
    }
  }
  return null;
}

// Strip unit text + commas: "226 lbs" -> 226, "15,828 ea" -> 15828, "-"/""/"0" handled by callers.
function num(x) {
  if (x == null) return null;
  if (typeof x === "number") return x;
  const s = String(x).trim();
  if (s === "" || s === "-") return 0;
  const cleaned = s.replace(/lbs|ea|cs|kg|,|\s/gi, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// An ingredient code is RMxxxx or an Elmers IN- compound code. Everything else is packaging.
function categoryFor(code) {
  return /^(RM|IN-)/i.test(String(code).trim()) ? "ingredient" : "packaging";
}

// ELMERS — spatial grid. Ingredient blocks carry the 90xxx supplier code in their "Item" column
// (col A of the block) and the IN-/RM HC SKU in the next column. The quantity sits under the
// block's "Units" (or "lbs") header — in this file's snapshot 3 cols right of the code, but the
// older demo grid was 2, so we locate it by the header, not a fixed offset.
export function parseElmers(grid, codeMap) {
  const rows = [], flags = [];
  for (const { hcode, desc, supcode } of codeMap) {
    // Match on whichever code the grid carries: supplier code (col A) or HC SKU (col B).
    const pos = (supcode ? findCell(grid, supcode) : null) || findCell(grid, hcode);
    if (!pos) {
      rows.push({ ingredient: desc, code: hcode, qty: 0, category: categoryFor(hcode), status: "not_found" });
      flags.push(`${desc} (code ${supcode || hcode}) not found in file`);
      continue;
    }
    const [r, c] = pos;
    const qty = elmersBlockQty(grid, r, c);
    rows.push({ ingredient: desc, code: hcode, qty: qty ?? 0, category: categoryFor(hcode), status: qty == null ? "no_qty" : "matched" });
    if (qty == null) flags.push(`${desc}: found code ${supcode || hcode} but no quantity beside it`);
  }
  return { rows, flags };
}

// Find the quantity for an Elmers ingredient row whose code is at [r, c].
// 1) Walk up to the block's header row (the row whose column c reads "Item") and use the column of
//    its "Units" or "lbs" header. 2) Fall back to scanning right for the first numeric cell.
function elmersBlockQty(grid, r, c) {
  for (let hr = r; hr >= 0 && r - hr < 12; hr--) {
    const head = grid[hr] || [];
    if (String(head[c] ?? "").trim().toLowerCase() === "item") {
      for (let cc = c; cc < head.length; cc++) {
        const h = String(head[cc] ?? "").trim().toLowerCase();
        if (h === "units" || h === "lbs") {
          const q = num(grid[r]?.[cc]);
          if (q != null) return q;
        }
      }
      break;
    }
  }
  for (let cc = c + 1; cc < (grid[r] || []).length; cc++) {
    const n = num(grid[r][cc]);
    if (n != null) return n;
  }
  return null;
}

// BAZZINI — transactional lot list: Item Number | Hormbles # | Desc | Location | Bin | Lot | Qty | UOM.
// The Hormbles code is in col B (index 1); Qty in col G (index 6). Sum Qty across every lot row per
// code (SUMIF). Keep only ingredient codes (RM…). codeMap (hcode->desc) is used only for labels.
export function parseBazzini(grid, codeMap = []) {
  const descByCode = {};
  for (const { hcode, desc } of codeMap) descByCode[hcode] = desc;
  const agg = {}; // code -> qty
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const code = row[1] == null ? "" : String(row[1]).trim();
    if (!/^RM/i.test(code)) continue; // ingredients only, per Hormbles' process
    const q = num(row[6]);
    if (q != null) agg[code] = (agg[code] || 0) + q;
  }
  const rows = [], flags = [];
  for (const code of Object.keys(agg)) {
    if (!descByCode[code]) flags.push(`Bazzini code ${code} has on-hand ${agg[code]} but no description in map`);
    rows.push({ ingredient: descByCode[code] || code, code, qty: round2(agg[code]), category: "ingredient", status: "matched" });
  }
  if (!rows.length) flags.push("Bazzini: no RM ingredient rows found");
  return { rows, flags };
}

// PALMER — categorized list: Category | RMP item # | Hormbles item # | Description | On Hand.
// Hormbles code in col C (index 2); On Hand in col E (index 4) carries unit text ("19,200 lbs",
// "24,000 ea") or "0"/"-". Strip the text to a number. Keep coded rows; packaging is tagged, not dropped.
export function parsePalmer(grid, codeMap = []) {
  const descByCode = {};
  for (const { hcode, desc } of codeMap) descByCode[hcode] = desc;
  const rows = [], flags = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const code = row[2] == null ? "" : String(row[2]).trim();
    if (!code) continue; // section-header / footer rows carry no code
    const qty = num(row[4]);
    const category = categoryFor(code);
    rows.push({ ingredient: descByCode[code] || (row[3] != null ? String(row[3]).trim() : code), code, qty: qty ?? 0, category, status: qty == null ? "no_qty" : "matched" });
    if (qty == null) flags.push(`Palmer ${code}: On Hand "${row[4]}" not parseable`);
  }
  if (!rows.length) flags.push("Palmer: no coded rows found");
  return { rows, flags };
}

// SPG (Superior Pack Group) — item-type table:
// Item code | Desc | Item type | Expiry | Lot | Default quantity | UOM | Full pallet qty | Inventory status.
// Keep rows where Item type (col C, index 2) = "Raw Material"; read Default quantity (col F, index 5).
// SPG mostly carries packaging + finished goods — few/no ingredient-grade raw materials; flag, don't error.
export function parseSPG(grid, codeMap = []) {
  const descByCode = {};
  for (const { hcode, desc } of codeMap) descByCode[hcode] = desc;
  const rows = [], flags = [];
  let ingredientHits = 0;
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (String(row[2] ?? "").trim() !== "Raw Material") continue;
    const code = row[0] == null ? "" : String(row[0]).trim();
    if (!code) continue;
    const qty = num(row[5]);
    const category = categoryFor(code);
    if (category === "ingredient") ingredientHits++;
    rows.push({ ingredient: descByCode[code] || (row[1] != null ? String(row[1]).trim() : code), code, qty: qty ?? 0, category, status: qty == null ? "no_qty" : "matched" });
  }
  if (ingredientHits === 0) flags.push("SPG: no ingredient-grade raw materials on sheet (SPG carries packaging + finished goods)");
  return { rows, flags };
}

// 3PL finished-goods (FST / Green Rabbit) — generic: item code col, qty col. Configurable indices.
// NOTE: 3PL finished-goods inventory is SEPARATE from co-man raw-material inventory — do not combine
// the two. Co-man inv -> ingredient buy-list; 3PL inv -> supply-plan starting inventory.
export function parse3PL(grid, { codeCol = 1, qtyCol = 3, startRow = 1 } = {}) {
  const rows = [], flags = [];
  for (let r = startRow; r < grid.length; r++) {
    const code = grid[r]?.[codeCol]; const qty = num(grid[r]?.[qtyCol]);
    if (code != null && String(code).trim() !== "") {
      rows.push({ sku: String(code).trim(), qty: qty ?? 0, status: qty == null ? "no_qty" : "matched" });
    }
  }
  return { rows, flags };
}

function round2(n) { return Math.round(n * 100) / 100; }

export const PARSERS = {
  elmers: parseElmers, bazzini: parseBazzini, palmer: parsePalmer, spg: parseSPG,
};
