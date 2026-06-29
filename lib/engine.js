// lib/engine.js
// The verified planning pipeline + suggestion logic for the four human decisions.
// Mirrors Hormbles' model: explosion -> production -> lbs -> ingredient needs -> net vs on-hand -> buy.

import { parse3PL } from "./parsers.js";
import { stripBaseSku } from "./source.js";

const GRAMS_TO_LBS = 453.59237;

// ---- combine: merge every co-man's normalized inventory into ONE on-hand picture ----
// This is the holistic fix: net total needs against COMBINED on-hand, never per-co-man (which
// double-counts / invents phantom buys — e.g. "buy 14,200 Camogie" when Camogie is sitting at Elmers).
// Input: { elmers: {rows, flags}, bazzini: {...}, palmer: {...}, spg: {...} }.
// Output: { combined: { code -> {code, ingredient, category, qty, sources:[{coman, qty}]} }, flags }.
// Sums qty by CODE across co-mans and records which co-mans contributed (for the "show the math" trace).
export function combineInventories(normalizedByComan) {
  const combined = {};
  const flags = [];
  for (const coman in normalizedByComan) {
    const res = normalizedByComan[coman];
    if (!res || !res.rows) continue;
    for (const f of res.flags || []) flags.push(`[${coman}] ${f}`);
    for (const row of res.rows) {
      const code = row.code == null ? "" : String(row.code).trim();
      if (!code) continue;
      const qty = row.qty || 0;
      if (!combined[code]) {
        combined[code] = { code, ingredient: row.ingredient || code, category: row.category || (/^(RM|IN-)/i.test(code) ? "ingredient" : "packaging"), qty: 0, sources: [] };
      }
      combined[code].qty = round(combined[code].qty + qty);
      combined[code].sources.push({ coman, qty });
    }
  }
  return { combined, flags };
}

// ---- combine 3PL opening inventory: SUMIF finished-goods EACHES by SKU across both warehouses ----
// Mirrors the client's "Total Inventory OH" tab = SUMIF(Green Rabbit eaches) + SUMIF(FST eaches) per SKU.
// This OPENING (finished-goods) inventory seeds the supply plan's month-1 starting inventory and is
// SEPARATE from the co-man combined RAW-material inventory — keep the two distinct everywhere.
// Input: { fst: {rows,flags}, greenRabbit: {rows,flags} } (parse3PL output). Output:
//   { opening: { sku -> {sku, qty, sources:[{warehouse, qty}]} }, flags }.
export function combineOpeningInventory({ fst, greenRabbit } = {}) {
  const opening = {};
  const flags = [];
  const add = (res, warehouse) => {
    if (!res || !res.rows) return;
    for (const f of res.flags || []) flags.push(`[${warehouse}] ${f}`);
    for (const row of res.rows) {
      const sku = row.sku == null ? "" : String(row.sku).trim();
      if (!sku) continue;
      if (!opening[sku]) opening[sku] = { sku, qty: 0, sources: [] };
      opening[sku].qty = round(opening[sku].qty + (row.qty || 0));
      opening[sku].sources.push({ warehouse, qty: row.qty || 0 });
    }
  };
  add(greenRabbit, "green_rabbit");
  add(fst, "fst");
  return { opening, flags };
}

// ---- combine co-man raw-material inventory from the SOURCE OF TRUTH (consolidated sheet rows) ----
// Sum Quantity On Hand by ingredient CODE (the Hormbles SKU) across every co-man row — Bazzini's many
// lot rows collapse here (SUMIF), and Elmer/Palmer/SPG one-per-code rows add in. Ingredient rows (RM…,
// IN-…) feed needs; packaging (PK-*) is kept but tagged so it can be excluded from needs. Unmatched
// ingredient codes (not in ingredientMap) are ALWAYS flagged, never dropped. Mirrors combineInventories'
// shape ({ code -> {code, ingredient, category, qty, unit, sources:[{source, qty}]} }) so the same
// downstream (combinedOnhandByName, buy-list) consumes it unchanged.
export function combineComan(rows = [], { ingredientMap = {} } = {}) {
  const combined = {}, flags = [];
  for (const row of rows) {
    const code = row.sku == null ? "" : String(row.sku).trim();
    if (!code) continue;
    const qty = Number(row.qty) || 0;
    const category = /^(RM|IN-)/i.test(code) ? "ingredient" : "packaging";
    if (!combined[code]) combined[code] = { code, ingredient: ingredientMap[code] || code, category, qty: 0, unit: row.unit || "", sources: [] };
    combined[code].qty = round(combined[code].qty + qty);
    if (row.unit && !combined[code].unit) combined[code].unit = row.unit;
    combined[code].sources.push({ source: row.source || "?", qty });
  }
  for (const code in combined) {
    if (combined[code].category === "ingredient" && !ingredientMap[code]) {
      flags.push(`Unmatched ingredient code ${code} (on-hand ${combined[code].qty}) — not in ingredient map`);
    }
  }
  return { combined, flags };
}

// ---- opening FINISHED-GOODS inventory from FST + GR source rows (kept SEPARATE from co-man raw) ----
// Per BASE SKU (suffix stripped): On Hand = FST Inventory_QTY + GR On Hand (summed across GR locations,
// done in the source parser); Available = FST Available_Qty + GR Available (summed). BOTH are surfaced,
// but ON HAND drives the planning calc (Available is reference). Returns { bySku: { base -> {sku, onHand,
// available, sources:[{warehouse, onHand, available}]} } }.
export function openingFinishedGoods(fstRows = [], grRows = []) {
  const bySku = {};
  const ensure = base => (bySku[base] || (bySku[base] = { sku: base, onHand: 0, available: 0, sources: [] }));
  for (const r of fstRows) {
    const e = ensure(stripBaseSku(r.base || r.sku));
    const onHand = Number(r.inventoryQty) || 0, available = Number(r.availableQty) || 0;
    e.onHand = round(e.onHand + onHand); e.available = round(e.available + available);
    e.sources.push({ warehouse: "fst", onHand, available });
  }
  for (const r of grRows) {
    const e = ensure(stripBaseSku(r.base || r.mfgId || r.sku));
    const onHand = Number(r.onHand) || 0, available = Number(r.available) || 0;
    e.onHand = round(e.onHand + onHand); e.available = round(e.available + available);
    e.sources.push({ warehouse: "green_rabbit", onHand, available });
  }
  return { bySku };
}

// ---- MULTI-MONTH ROLLING PLAN ----
// Plan a finished SKU across consecutive months. The rolling part: each month's ENDING inventory carries
// into the next month as its OPENING (month 1 opening = current FST+GR on-hand). Production each month is
// suggested to cover net demand (pallets, overridable); overriding one month re-rolls the downstream months.
// Raw-material on-hand also carries forward (consumed across months), so month 2's buy nets against what
// month 1 left. needsForPallets(pallets) -> { ingredient: lbs needed } is INJECTED (the verified engine), so
// this stays pure and the per-month engine math is unchanged. Returns { months:[...], combinedNeeds, combinedBuy }.
export function rollMultiMonth({ startMonth, numMonths = 1, demandByMonth = {}, openingFinishedGoods = 0, openingRawMaterials = {}, constants = {}, overrides = {}, needsForPallets } = {}) {
  const minisPerPallet = constants.minisPerPallet || 30600;
  const WEEKS_PER_MONTH = 4.33;
  const allMonths = Object.keys(demandByMonth).sort();
  const startIdx = startMonth ? allMonths.indexOf(startMonth) : 0;
  const months = startIdx >= 0 ? allMonths.slice(startIdx, startIdx + numMonths) : [];
  const results = [];
  let opening = openingFinishedGoods;
  const rawRemaining = { ...openingRawMaterials };
  const combinedNeeds = {};
  for (const month of months) {
    const demand = demandByMonth[month] || 0;
    const netDemand = Math.max(0, demand - opening);
    const suggestedPallets = Math.ceil(netDemand / minisPerPallet); // 0 when covered; never a hard 1
    const ov = overrides[month];
    const overridden = ov != null && Number.isFinite(ov);
    const pallets = overridden ? ov : suggestedPallets;
    const receipts = pallets * minisPerPallet;
    const ending = round(opening + receipts - demand);
    // Forward demand = the next month in the horizon (beyond the selected range if present), else this month's demand.
    const fwdIdx = allMonths.indexOf(month) + 1;
    const forwardDemand = fwdIdx < allMonths.length ? (demandByMonth[allMonths[fwdIdx]] || 0) : demand;
    const monthsOfSupply = forwardDemand > 0 ? round(ending / forwardDemand) : null;
    const weeksOfSupply = forwardDemand > 0 ? round(ending / (forwardDemand / WEEKS_PER_MONTH)) : null;
    // Per-month ingredient needs + buy-list; raw on-hand carries forward (consume, net the shortfall).
    const needs = needsForPallets ? needsForPallets(pallets) : {};
    const buy = {};
    for (const ing in needs) {
      const need = needs[ing];
      const have = rawRemaining[ing] || 0;
      buy[ing] = round(Math.max(0, need - have));
      rawRemaining[ing] = Math.max(0, round(have - need));
      combinedNeeds[ing] = round((combinedNeeds[ing] || 0) + need);
    }
    results.push({
      month, opening: round(opening), demand, netDemand: round(netDemand), suggestedPallets, pallets, overridden,
      receipts, ending, forwardDemand, weeksOfSupply, monthsOfSupply, needs, buy,
      why: `Demand ${fmt(demand)} − opening ${fmt(round(opening))} = ${fmt(round(netDemand))} → ÷ ${fmt(minisPerPallet)}/pallet ≈ ${suggestedPallets} pallet${suggestedPallets === 1 ? "" : "s"}`,
    });
    opening = ending; // ROLL: this month's ending becomes next month's opening
  }
  // Combined buy-list for forward-buying = total needs across months, net against the opening raw pool.
  const combinedBuy = {};
  for (const ing in combinedNeeds) combinedBuy[ing] = round(Math.max(0, combinedNeeds[ing] - (openingRawMaterials[ing] || 0)));
  return { months: results, combinedNeeds, combinedBuy };
}

// Plain-English label per opening-inventory source tier (shown in the UI so the active path is never ambiguous).
export const OPENING_SOURCE_LABEL = {
  uploads: "FST + Green Rabbit uploads",
  demo: "FST + Green Rabbit",
  standin: "Total Inventory OH",
};

// ---- opening-inventory SOURCE SELECTION (explicit 3-tier priority) ----
// Decide which finished-goods source seeds the supply plan's starting inventory, and NEVER break /
// return empty when 3PL data is missing:
//   (1) uploaded FST/Green Rabbit grids  →  (2) demo FST/GR sample grids  →  (3) opening_inv stand-in.
// Tiers 1 & 2 parse + combine eaches (parse3PL/combineOpeningInventory) and quietly cross-check each
// SKU's computed total against the opening_inv reference. Tier 3 builds the map straight from opening_inv.
// Returns { opening, source, sourceLabel, flags, crossCheck:{ sku -> {computed, reference, match} } }.
export function resolveOpeningInventory({ uploadFst, uploadGr, demoFst, demoGr, openingInv = [], codeMap } = {}) {
  const has = g => Array.isArray(g) && g.length > 0;
  let source, fstGrid = null, grGrid = null;
  if (has(uploadFst) || has(uploadGr)) { source = "uploads"; fstGrid = has(uploadFst) ? uploadFst : null; grGrid = has(uploadGr) ? uploadGr : null; }
  else if (has(demoFst) || has(demoGr)) { source = "demo"; fstGrid = has(demoFst) ? demoFst : null; grGrid = has(demoGr) ? demoGr : null; }
  else source = "standin";

  if (source === "standin") {
    const opening = {};
    for (const o of openingInv) opening[o.sku] = { sku: o.sku, qty: o.qty || 0, sources: [{ warehouse: "opening_inv", qty: o.qty || 0 }] };
    return { opening, source, sourceLabel: OPENING_SOURCE_LABEL.standin, flags: [], crossCheck: {} };
  }

  const opts = codeMap ? { codeMap } : {};
  const fst = fstGrid ? parse3PL(fstGrid, opts) : { rows: [], flags: [] };
  const greenRabbit = grGrid ? parse3PL(grGrid, opts) : { rows: [], flags: [] };
  const { opening, flags } = combineOpeningInventory({ fst, greenRabbit });

  const ref = {};
  for (const o of openingInv) ref[o.sku] = o.qty || 0;
  const crossCheck = {};
  for (const sku in opening) {
    if (ref[sku] == null) continue;
    const computed = opening[sku].qty, reference = ref[sku];
    crossCheck[sku] = { computed, reference, match: Math.abs(computed - reference) < 0.5 };
  }
  return { opening, source, sourceLabel: OPENING_SOURCE_LABEL[source], flags, crossCheck };
}

// ---- DISPLAY-ONLY classification of 3PL opening-inventory SKUs ----
// Opening *finished-goods* inventory must list finished bars only. The raw 3PL exports also carry
// packaging (PK-*, HC*) and junk/non-SKU artifacts ("Wafer S", "Double-", "14 BOXE", "BB101"). This
// classifier groups SKUs for the UI WITHOUT touching the combine/reconciliation math (which still sums
// every row). Returns "finished" | "packaging" | "unknown".
//   finishedSkus = known finished-goods codes (build with finishedGoodsSkus()). A SKU also counts as
//   finished if its product-family prefix (leading letters, e.g. BCC3004 -> "BCC", BVAR200 -> "BVAR")
//   matches a known finished SKU's prefix — this keeps real-but-zero bars (BCC3004, BVAR200x) while
//   still rejecting look-alike junk (BB101 -> "BB", not a known family).
export function classifyOpeningSku(sku, finishedSkus = []) {
  const s = String(sku == null ? "" : sku).trim();
  if (!s) return "unknown";
  const known = new Set(finishedSkus);
  if (known.has(s)) return "finished";
  if (/^(PK-|HC)/i.test(s)) return "packaging";
  const fam = s.match(/^[A-Za-z]+/);
  if (fam && /\d/.test(s)) {
    const prefixes = new Set([...known].map(k => (String(k).match(/^[A-Za-z]+/) || [""])[0].toUpperCase()).filter(Boolean));
    if (prefixes.has(fam[0].toUpperCase())) return "finished";
  }
  return "unknown";
}

// Build the known finished-goods SKU list from seed reference data (opening_inv ∪ refprod ∪ bom.finished),
// excluding packaging (PK-*, HC*) and WIP (-WIP) codes. Used by classifyOpeningSku for the display filter.
export function finishedGoodsSkus({ opening_inv = [], refprod = {}, bom = [] } = {}) {
  const set = new Set();
  for (const o of opening_inv) if (o && o.sku) set.add(o.sku);
  for (const k of Object.keys(refprod)) set.add(k);
  for (const b of bom) if (b && b.finished) set.add(b.finished);
  return [...set].filter(s => s && !/^(PK-|HC)/i.test(s) && !/-WIP$/i.test(s));
}

// Re-key combined on-hand by canonical ingredient NAME (the name the recipes use), so the buy-list
// can net needs (keyed by recipe ingredient name) against combined on-hand. ingredientMap: code->name.
// Only ingredient-category codes are bridged; packaging is excluded from ingredient needs.
export function combinedOnhandByName(combined, ingredientMap = {}) {
  const byName = {};
  for (const code in combined) {
    const entry = combined[code];
    if (entry.category !== "ingredient") continue;
    const name = ingredientMap[code];
    if (!name) continue; // unmapped ingredient code: surfaced via flags, not silently merged
    byName[name] = round((byName[name] || 0) + entry.qty);
  }
  return byName;
}

// ---- production: pallets -> units -> lbs (for WIP minis); bars come in as lbs from schedule ----
export function productionLbs({ palletsByWip, refprod, barsLbs = {} }) {
  const prodLbs = { ...barsLbs };
  for (const wip in palletsByWip) {
    const pallets = palletsByWip[wip] || 0;
    const rp = refprod[wip];
    if (!rp) continue;
    const units = pallets * (rp.minis_pallet || 0);
    const grams = rp.size_g || rp.grams || 8;
    prodLbs[wip] = units * grams / GRAMS_TO_LBS;
    prodLbs[`${wip}__units`] = units;
  }
  return prodLbs;
}

// ---- ingredient needs: sum over producing SKUs of prodLbs * pct * (1+scrap) ----
export function ingredientNeeds({ prodLbs, recipes, location }) {
  const needs = {};
  for (const sku in recipes) {
    const lbs = prodLbs[sku];
    if (!lbs) continue;
    for (const line of recipes[sku]) {
      if (location && line.loc && line.loc !== location) continue;
      const add = lbs * line.pct * (1 + (line.scrap || 0));
      needs[line.ingredient] = (needs[line.ingredient] || 0) + add;
    }
  }
  return needs;
}

// ---- buy list: need - onhand - actuals, gated by decisions ----
export function buyList({ needs, onhand, actuals = {}, buyDecisions = {} }) {
  const out = [];
  for (const ingr in needs) {
    const need = needs[ingr];
    const have = (onhand[ingr] || 0) + (actuals[ingr] || 0);
    const shortfall = Math.max(0, need - have);
    const decided = buyDecisions[ingr];
    const buy = decided != null ? decided : 0;
    out.push({
      ingredient: ingr, need: round(need), onhand: have, shortfall: round(shortfall),
      buy, remaining: round(have - need + buy),
    });
  }
  return out;
}

// ================= SUGGESTIONS (Path B) =================
// Each returns { value, why } so the UI can show the reasoning. All overridable manually.

export function suggestPallets({ wip, demandPouches, minisPerPouch = 11, startInv = 0, refprod, targetMonths = 1.5 }) {
  const rp = refprod[wip];
  const minisPerPallet = rp?.minis_pallet || 30600;
  const minisNeeded = demandPouches * minisPerPouch * targetMonths - startInv;
  const pallets = Math.max(1, Math.ceil(minisNeeded / minisPerPallet));
  return { value: pallets,
    why: `Target ${targetMonths}mo: (${fmt(demandPouches)} pouches × ${minisPerPouch} × ${targetMonths} − ${fmt(startInv)}) ÷ ${fmt(minisPerPallet)}/pallet ≈ ${pallets}` };
}

// Derive the pallets-to-run suggestion from UPSTREAM DEMAND (Modis) instead of a generic months-of-supply
// guess: demand for the SKU/month − on-hand finished goods = net units to produce, ÷ minis-per-pallet → pallets.
// Modis carries the FINISHED/mini SKU (e.g. MBMC4001); production is keyed by the WIP code, so bridge
// finished → WIP via the BOM (finished→wip) to read the right minis_pallet. Returns { value, why } like the
// other suggestions (overridable). If the SKU can't be bridged to a production rate, return value:null + a
// flag rather than silently producing 0. Replaces suggestPallets() WHEN Modis demand exists; else fall back.
export function suggestPalletsFromDemand({ sku, month, demandBySkuMonth = {}, openingInv = [], refprod = {}, bom = [], minisPerPouch } = {}) {
  const flags = [];
  const demand = (demandBySkuMonth[sku] && demandBySkuMonth[sku][month]) || 0;
  // On-hand finished goods for this SKU (3PL opening inventory). Accept the opening_inv array shape
  // [{sku,qty}] OR a combined map { sku:{qty} } / { sku:qty }.
  let onhand = 0;
  if (Array.isArray(openingInv)) { const o = openingInv.find(x => x && x.sku === sku); onhand = o ? (o.qty || 0) : 0; }
  else if (openingInv && typeof openingInv === "object") { const v = openingInv[sku]; onhand = v == null ? 0 : (typeof v === "object" ? (v.qty || 0) : v); }
  const net = Math.max(0, demand - onhand);
  // Bridge finished SKU → WIP via the BOM to find the production rate (minis per pallet).
  const bridge = bom.find(b => b && b.finished === sku);
  const wip = bridge ? bridge.wip : null;
  const rp = (wip && refprod[wip]) || refprod[sku] || null;
  const minisPerPallet = rp ? (rp.minis_pallet || 0) : 0;
  if (!minisPerPallet) {
    flags.push(`No production rate (minis/pallet) for ${sku}${wip ? ` (WIP ${wip})` : " — no BOM finished→WIP bridge"} — set pallets manually`);
    return { value: null, why: `Demand ${fmt(demand)} for ${sku} ${month || ""}, but no production rate is known${wip ? ` for ${wip}` : ""} — set pallets manually.`, demand, onhand, net, wip, minisPerPallet: 0, flags };
  }
  const value = Math.max(0, Math.ceil(net / minisPerPallet));
  const why = net > 0
    ? `Demand ${fmt(demand)} − on-hand ${fmt(onhand)} = ${fmt(net)} → ÷ ${fmt(minisPerPallet)}/pallet ≈ ${value} pallet${value === 1 ? "" : "s"}${wip ? ` (${sku}→${wip})` : ""}`
    : `Demand ${fmt(demand)} ≤ on-hand ${fmt(onhand)} — covered this month → 0 new pallets (override to build ahead).`;
  return { value, why, demand, onhand, net, wip, minisPerPallet, flags };
}

export function suggestOtherVolume({ lastMonth = 0 }) {
  return { value: lastMonth, why: lastMonth ? `Carry-forward: same as last month (${fmt(lastMonth)}). No live sample source yet.` : `Default 0 — no samples logged.` };
}

export function suggestBuy({ ingredient, need, have, roundTo = 100 }) {
  const short = Math.max(0, need - have);
  if (short <= 0) return { value: 0, why: `On-hand ${fmt(have)} ≥ need ${fmt(Math.round(need))} — nothing to buy.` };
  const value = Math.ceil(short / roundTo) * roundTo;
  return { value, why: `Short ${fmt(Math.round(short))} (need ${fmt(Math.round(need))} − have ${fmt(have)}) → round up to ${fmt(value)}. Buffer/MOQ rule TBD.` };
}

export function suggestActuals() {
  return { value: 0, why: `Default 0. Suggested automatically once in-transit tracking is connected.` };
}

// ================= EXPLAIN / TRACE HELPERS =================
// Each produces the SAME number as the canonical function above, paired with a plain-English
// derivation tied to this run's real inputs. The UI renders {value, trace}; verify.mjs asserts each
// trace value equals the canonical engine output, so the shown math can never drift from the result.
// Rule: never recompute a number for display elsewhere — get it (and its trace) from here.

// Production: pallets -> units -> lbs, with the derivation for each.
export function explainProduction({ pallets, minisPerPallet, grams }) {
  const units = pallets * minisPerPallet;
  const lbs = units * grams / GRAMS_TO_LBS;
  return {
    units, lbs,
    unitsTrace: `${fmt(pallets)} pallets × ${fmt(minisPerPallet)} minis/pallet = ${fmt(units)} units`,
    lbsTrace: `${fmt(units)} units × ${grams}g ÷ ${GRAMS_TO_LBS} = ${fmt(round(lbs))} lbs`,
  };
}

// Combined on-hand cell: the per-co-man breakdown that summed to entry.qty.
export function explainCombined(entry, labels = {}) {
  const parts = (entry.sources || []).filter(s => s.qty);
  const sumStr = parts.length ? parts.map(s => `${labels[s.coman] || s.coman} ${fmt(s.qty)}`).join(" + ") : "0";
  return { value: entry.qty, trace: `${sumStr} = ${fmt(entry.qty)}` };
}

// Opening-inventory cell: the per-warehouse (FST/Green Rabbit) breakdown that summed to entry.qty.
export function explainOpening(entry, labels = {}) {
  const parts = (entry.sources || []).filter(s => s.qty);
  const sumStr = parts.length ? parts.map(s => `${labels[s.warehouse] || s.warehouse} ${fmt(s.qty)}`).join(" + ") : "0";
  return { value: entry.qty, trace: `${sumStr} = ${fmt(entry.qty)}` };
}

// Ingredient need: prod lbs × recipe % × (1 + scrap), summed over every producing SKU at this location.
// Same formula as ingredientNeeds(); returns the per-SKU parts so the trace shows each contribution.
export function explainNeed({ ingredient, prodLbs, recipes, location }) {
  const parts = [];
  let total = 0;
  for (const sku in recipes) {
    const lbs = prodLbs[sku];
    if (!lbs) continue;
    for (const line of recipes[sku]) {
      if (line.ingredient !== ingredient) continue;
      if (location && line.loc && line.loc !== location) continue;
      const contribution = lbs * line.pct * (1 + (line.scrap || 0));
      parts.push({ sku, lbs, pct: line.pct, scrap: line.scrap || 0, contribution });
      total += contribution;
    }
  }
  const partStr = parts.map(p =>
    `${p.sku}: ${fmt(round(p.lbs))} lbs × ${pct(p.pct)} × (1 + ${pct(p.scrap)} scrap) = ${fmt(round(p.contribution))}`
  ).join("  +  ");
  const trace = !parts.length
    ? `No producing SKU uses ${ingredient}${location ? ` at ${location}` : ""}.`
    : (parts.length > 1 ? `${partStr}  =  ${fmt(round(total))}` : partStr);
  return { value: total, trace, parts };
}

// Buy-list row: format the netting + remaining derivations straight from the engine's row values
// (no recompute — these strings use the exact numbers buyList() produced).
export function explainBuyRow(row) {
  const net = round(row.need - row.onhand);
  const buyTrace = row.shortfall > 0
    ? `need ${fmt(row.need)} − combined on-hand ${fmt(row.onhand)} = ${fmt(net)} short → buy ${fmt(row.buy)}`
    : `need ${fmt(row.need)} − combined on-hand ${fmt(row.onhand)} = ${fmt(net)} → covered → buy 0`;
  const remainingTrace = `on-hand ${fmt(row.onhand)} − need ${fmt(row.need)} + buy ${fmt(row.buy)} = ${fmt(row.remaining)}`;
  return { buyTrace, remainingTrace };
}

// ---- helpers ----
function round(n) { return Math.round(n * 100) / 100; }
function fmt(n) { return (n ?? 0).toLocaleString(); }
function pct(n) { return `${+( (n || 0) * 100).toFixed(3)}%`; }
