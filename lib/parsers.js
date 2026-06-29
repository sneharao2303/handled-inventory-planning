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

// 3PL finished-goods (FST = retail, Green Rabbit = DTC) — both warehouses share ONE export layout:
//   (A blank) | SKU Code (B/1) | Qty cases (C/2) | Qty sleeves (D/3) | Qty EACHES (E/4) | Warehouse SKU (F/5)
// SUMIF the EACHES column by SKU Code (a SKU can repeat). Detect the header row by finding "SKU Code"
// (Green Rabbit starts ~row 5, FST ~row 4 — never hardcode). Sum eaches only, never cases/sleeves.
// Optional codeMap (warehouse SKU -> Hormbles SKU) for exports that only carry the warehouse's own code;
// when a map is supplied, any code not in it is flagged "unresolved" (surfaced, never silently dropped).
// NOTE: 3PL finished-goods inventory is SEPARATE from co-man raw-material inventory — do not merge them.
// Co-man inv -> ingredient buy-list; 3PL inv -> supply-plan opening/starting inventory.
export function parse3PL(grid, { codeMap = {}, codeCol = 1, qtyCol = 4 } = {}) {
  const flags = [];
  const mapped = codeMap && Object.keys(codeMap).length > 0;
  let header = -1;
  for (let r = 0; r < grid.length; r++) {
    if ((grid[r] || []).some(c => c != null && String(c).trim().toLowerCase() === "sku code")) { header = r; break; }
  }
  if (header < 0) flags.push('3PL: no "SKU Code" header row found — reading from the top');
  const agg = {}; // resolved SKU -> summed eaches
  for (let r = header + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const raw = row[codeCol] == null ? "" : String(row[codeCol]).trim();
    if (!raw) continue;
    let sku = raw, status = "matched";
    if (mapped) {
      if (codeMap[raw]) sku = codeMap[raw];
      else { status = "unresolved"; flags.push(`3PL SKU "${raw}" not in code map — unresolved`); }
    }
    const q = num(row[qtyCol]); // blank/"-" -> 0 via num()
    if (!agg[sku]) agg[sku] = { qty: 0, status };
    agg[sku].qty += q == null ? 0 : q;
    if (status === "unresolved") agg[sku].status = "unresolved";
  }
  const rows = Object.keys(agg).map(sku => ({ sku, qty: round2(agg[sku].qty), status: agg[sku].status }));
  if (!rows.length) flags.push("3PL: no SKU rows found");
  return { rows, flags };
}
// Explicit, self-documenting names — both warehouses use the identical reader.
export function parseFST(grid, opts = {}) { return parse3PL(grid, opts); }
export function parseGreenRabbit(grid, opts = {}) { return parse3PL(grid, opts); }

// MODIS — the upstream DEMAND forecast (one row per retailer × SKU × month; rolling ~14-month horizon).
// This is the real START of planning: it says how much will be SOLD, which (minus on-hand finished goods)
// drives how much to PRODUCE. Column order varies, so locate columns by header NAME: "SKU Code", a
// month/date column, "Forecasted Delivery" (the demand qty), and "Status" (Confirmed / Not Confirmed).
// Aggregate = SUM Forecasted Delivery by (SKU, Month) — many retailer rows collapse to one number per
// SKU per month. Keep ALL months (sets up multi-month planning) — NEVER collapse to a single month.
// Returns { demandBySkuMonth:{sku:{month:qty}}, demandConfirmedBySkuMonth:{...}, months:[...], skus:[...], flags:[...] }.
// demandBySkuMonth is the default TOTAL (confirmed + unconfirmed); demandConfirmedBySkuMonth is the
// confirmed-only view. A SKU whose demand is entirely unconfirmed is flagged (surfaced, never dropped).
export function parseModis(grid) {
  const empty = { demandBySkuMonth: {}, demandConfirmedBySkuMonth: {}, months: [], skus: [], flags: [] };
  if (!Array.isArray(grid) || !grid.length) return { ...empty, flags: ["Modis: empty file"] };
  // Find the header row + the columns we need by name (order is not fixed).
  let header = -1, col = {};
  for (let r = 0; r < grid.length; r++) {
    const idx = {};
    (grid[r] || []).forEach((cell, c) => {
      const h = String(cell == null ? "" : cell).trim().toLowerCase();
      if (h === "sku code" || h === "sku") idx.sku = c;
      else if (/forecast.*deliver|forecasted delivery|forecast qty|^forecast$/.test(h)) { if (idx.qty == null) idx.qty = c; }
      else if (h === "status") idx.status = c;
      else if (/month|date|period/.test(h)) { if (idx.month == null) idx.month = c; }
    });
    if (idx.sku != null && idx.qty != null) { header = r; col = idx; break; }
  }
  if (header < 0) return { ...empty, flags: ['Modis: no header row with "SKU Code" + "Forecasted Delivery" found'] };
  const flags = [];
  if (col.month == null) flags.push("Modis: no month/date column found — demand not separated by month");
  if (col.status == null) flags.push("Modis: no Status column — treating every row as confirmed");

  const total = {}, confirmed = {};
  const sawConfirmed = {}, sawUnconfirmed = {};
  const monthsSet = new Set();
  for (let r = header + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const sku = row[col.sku] == null ? "" : String(row[col.sku]).trim();
    if (!sku) continue;
    const q = num(row[col.qty]);
    if (q == null) continue;
    const month = (col.month != null && row[col.month] != null && String(row[col.month]).trim() !== "")
      ? String(row[col.month]).trim() : "(unspecified)";
    monthsSet.add(month);
    const statusRaw = col.status != null ? String(row[col.status] == null ? "" : row[col.status]).trim().toLowerCase() : "";
    const isUnconfirmed = /not\s*confirmed|unconfirmed|pending|tentative/.test(statusRaw);
    if (!total[sku]) total[sku] = {};
    total[sku][month] = round2((total[sku][month] || 0) + q);
    if (isUnconfirmed) sawUnconfirmed[sku] = true;
    else {
      sawConfirmed[sku] = true;
      if (!confirmed[sku]) confirmed[sku] = {};
      confirmed[sku][month] = round2((confirmed[sku][month] || 0) + q);
    }
  }
  for (const sku of Object.keys(total)) {
    if (sawUnconfirmed[sku] && !sawConfirmed[sku]) flags.push(`Modis: ${sku} demand is entirely unconfirmed (Not Confirmed)`);
  }
  return { demandBySkuMonth: total, demandConfirmedBySkuMonth: confirmed, months: [...monthsSet].sort(), skus: Object.keys(total).sort(), flags };
}

function round2(n) { return Math.round(n * 100) / 100; }

export const PARSERS = {
  elmers: parseElmers, bazzini: parseBazzini, palmer: parsePalmer, spg: parseSPG,
  fst: parseFST, green_rabbit: parseGreenRabbit,
};

// ---- combined-workbook routing ----
// Route a workbook TAB NAME to a source key (case-insensitive substring), or null to SKIP it.
// Non-data tabs ("FST and GR portal logins", notes, etc.) are skipped — and skip-patterns are checked
// FIRST, because "FST and GR portal logins" also contains the substring "fst" and must NOT route to FST.
// Green Rabbit is matched before FST for the same reason ("Green Rabbit" has no "fst", but keep intent clear).
export function routeTabName(tabName) {
  const n = String(tabName == null ? "" : tabName).toLowerCase();
  if (!n.trim()) return null;
  if (/portal|login|note|instruction|readme|cover|index|summary/.test(n)) return null; // non-data tabs → skip
  if (/green|rabbit/.test(n)) return "green_rabbit";
  if (/fst/.test(n)) return "fst";
  if (/elmer/.test(n)) return "elmers";
  if (/bazzini/.test(n)) return "bazzini";
  if (/palmer/.test(n)) return "palmer";
  if (/superior|spg|pack/.test(n)) return "spg";
  return null; // unrecognized → skip (never error)
}

export const COMAN_SOURCES = ["elmers", "bazzini", "palmer", "spg"];
export const THREEPL_SOURCES = ["fst", "green_rabbit"];

// Route a combined CO-MAN workbook { tabName: grid } into per-co-man grids + detection metadata.
// CO-MAN ONLY: FST / Green Rabbit are downloaded from their portals and uploaded SEPARATELY (Section 2),
// so any FST/GR tab found inside a co-man workbook is bucketed into `threePL` and IGNORED here (never
// routed into the pipeline) — this prevents double-counting 3PL inventory. Portal/notes/unrecognized →
// `skipped`. Returns { routed:{comanSrc->grid}, detected:[{tab,source}], threePL:[{tab,source}],
// skipped:[tab], duplicates:[{source,tab}], missing:[comanSrc] }. routed feeds the SAME parsers/combine.
export function routeWorkbookTabs(tabKeyed = {}) {
  const routed = {}, detected = [], threePL = [], skipped = [], duplicates = [];
  for (const tab of Object.keys(tabKeyed)) {
    const src = routeTabName(tab);
    if (src === "fst" || src === "green_rabbit") { threePL.push({ tab, source: src }); continue; } // handled in Section 2
    if (!src) { skipped.push(tab); continue; }
    if (routed[src] != null) { duplicates.push({ source: src, tab }); continue; } // first tab wins
    routed[src] = tabKeyed[tab];
    detected.push({ tab, source: src });
  }
  const missing = COMAN_SOURCES.filter(s => routed[s] == null);
  return { routed, detected, threePL, skipped, duplicates, missing };
}
