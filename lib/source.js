// lib/source.js
// SOURCE OF TRUTH. The tool opens with inventory ALREADY aggregated from a synced data source — a
// consolidated sheet (data/inventory_source_final.csv, bundled) or a live URL (INVENTORY_SOURCE_URL).
// We NEVER make the user upload to see data, and we NEVER surface the URL/sheet mechanics in the UI
// ("synced data source" / "our system" only). The sheet has THREE column-sections in order:
//   1. Co-man columns          (Elmer / Bazzini / R.M. Palmer / SPG rows): Source | Last Updated At |
//                               Item Code | SKU | Lot Number | Expiry Date | Quantity On Hand | Unit of Measure
//   2. FST columns  (prefix "FST: ")  — FST: SKU, FST: Inventory_QTY, FST: Available_Qty, ...
//   3. GR columns   (prefix "GR: ")   — GR: MFG ID, per-location GR: <Loc> On Hand / Available / Committed
// Each row populates only its own section. Co-man → ingredient buy-list; FST/GR → finished-goods starting
// inventory (kept SEPARATE). loadSource() returns { coman, fst, gr, lastUpdated, perSourceUpdated, stats }.

// Configurable synced URL. If set, fetch live on load; else / on failure → bundled CSV. Never blank.
export const INVENTORY_SOURCE_URL = ""; // e.g. "https://our-system.example/inventory_source_final.csv"

const COMAN_SOURCES = ["Elmer Candy Corporation", "Bazzini", "R.M. Palmer", "SPG"];

// Strip the warehouse/pack suffix to the base finished-goods SKU: -12, -MC6, -MC3, -6, -9, -MC4, etc.
export function stripBaseSku(sku) {
  return String(sku == null ? "" : sku).trim().replace(/-(?:MC\d+|\d+)$/i, "");
}

// Readable SKU label: "CODE — Name" when a friendly name is known (from FST/GR Description or ref data),
// else just "CODE". `names` is a { code -> name } map (build from opening_inv descriptions / ref product).
export function skuLabel(code, names = {}) {
  const c = String(code == null ? "" : code).trim();
  const n = names[c];
  return n ? `${c} — ${n}` : c;
}

// Minimal CSV parser (handles quoted fields + embedded commas/quotes). Returns array of cell-arrays.
function parseCsvRows(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

function toNum(x) {
  if (x == null || String(x).trim() === "") return 0;
  const n = parseFloat(String(x).replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
}

// Parse the consolidated sheet text into the three sections + stats. Pure (no IO) so it runs in node + browser.
export function parseSourceCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return { coman: [], fst: [], gr: [], lastUpdated: null, perSourceUpdated: {}, stats: { skus: 0, sources: 0 }, flags: ["source: empty sheet"] };
  const header = rows[0].map(h => String(h).trim());
  const col = {}; header.forEach((h, i) => (col[h] = i));
  const get = (r, name) => (col[name] != null ? r[col[name]] : undefined);
  // GR location columns: anything "GR: <loc> On Hand" / "... Available" (sum across locations).
  const grOnHandCols = header.filter(h => /^GR: /.test(h) && /on hand$/i.test(h));
  const grAvailCols = header.filter(h => /^GR: /.test(h) && /available$/i.test(h));

  const coman = [], fst = [], gr = [];
  const perSourceUpdated = {};
  let lastUpdated = null;
  const noteUpdate = (src, when) => {
    if (!when) return;
    if (!perSourceUpdated[src] || when > perSourceUpdated[src]) perSourceUpdated[src] = when;
    if (!lastUpdated || when > lastUpdated) lastUpdated = when;
  };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const source = String(get(r, "Source") || "").trim();
    const updated = String(get(r, "Last Updated At") || "").trim();
    const fstSku = String(get(r, "FST: SKU") || "").trim();
    const grId = String(get(r, "GR: MFG ID") || "").trim();
    if (fstSku) {
      noteUpdate(source || "FST Logistics", updated);
      fst.push({
        source: source || "FST Logistics", lastUpdated: updated, sku: fstSku, base: stripBaseSku(fstSku),
        inventoryQty: toNum(get(r, "FST: Inventory_QTY")), availableQty: toNum(get(r, "FST: Available_Qty")),
        allocatedQty: toNum(get(r, "FST: Allocated_QTY")), nonsaleableQty: toNum(get(r, "FST: Nonsaleable_QTY")),
        shippingLaneQty: toNum(get(r, "FST: Shipping_Lane_QTY")), skuType: String(get(r, "FST: SKU_Type") || "").trim(),
        skuStatus: String(get(r, "FST: SKU_Status") || "").trim(),
      });
    } else if (grId) {
      const onHand = grOnHandCols.reduce((a, h) => a + toNum(r[col[h]]), 0);
      const available = grAvailCols.reduce((a, h) => a + toNum(r[col[h]]), 0);
      noteUpdate(source || "Green Rabbit", updated);
      gr.push({
        source: source || "Green Rabbit", lastUpdated: updated, mfgId: grId, base: stripBaseSku(grId),
        onHand, available, byLocation: grOnHandCols.map(h => ({ loc: h.replace(/^GR: /, "").replace(/ on hand$/i, ""), onHand: toNum(r[col[h]]) })),
      });
    } else if (source) {
      noteUpdate(source, updated);
      coman.push({
        source, lastUpdated: updated, itemCode: String(get(r, "Item Code") || "").trim(),
        sku: String(get(r, "SKU") || "").trim(), lot: String(get(r, "Lot Number") || "").trim(),
        expiry: String(get(r, "Expiry Date") || "").trim(), qty: toNum(get(r, "Quantity On Hand")),
        unit: String(get(r, "Unit of Measure") || "").trim(),
      });
    }
  }

  // Stats: distinct SKUs across all sections, distinct sources present.
  const skuSet = new Set();
  coman.forEach(r => r.sku && skuSet.add(r.sku));
  fst.forEach(r => skuSet.add(r.base));
  gr.forEach(r => skuSet.add(r.base));
  const sourceSet = new Set([...coman.map(r => r.source), ...fst.map(r => r.source), ...gr.map(r => r.source)].filter(Boolean));
  return { coman, fst, gr, lastUpdated, perSourceUpdated, stats: { skus: skuSet.size, sources: sourceSet.size }, flags: [] };
}

// Load the source: live URL when configured, else bundled CSV. NEVER blank — falls back to bundled text.
// Pass `csvText` (bundled/inlined) and optionally `fetchImpl` (browser fetch) / `url`. Async.
export async function loadSource({ url = INVENTORY_SOURCE_URL, csvText = "", fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (url && f) {
    try {
      const res = await f(url);
      if (res && res.ok) {
        const text = await res.text();
        if (text && text.trim()) return { ...parseSourceCsv(text), origin: "synced" };
      }
    } catch { /* fall through to bundled — never blank */ }
  }
  if (csvText && csvText.trim()) return { ...parseSourceCsv(csvText), origin: "bundled" };
  return { coman: [], fst: [], gr: [], lastUpdated: null, perSourceUpdated: {}, stats: { skus: 0, sources: 0 }, flags: ["source: no data available"], origin: "empty" };
}

// Optional OVERRIDE upload — CAPTURE ONLY. Store a reference to the file in session state; do NOT parse,
// merge, or re-aggregate it (that is a later iteration). The already-loaded data keeps driving everything.
export function captureOverride(state = {}, fileRef = {}) {
  return {
    ...state,
    override: { name: fileRef.name || "uploaded file", size: fileRef.size ?? null, capturedAt: fileRef.capturedAt || null, processed: false },
  };
}
