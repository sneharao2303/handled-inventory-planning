// lib/engine.js
// The verified planning pipeline + suggestion logic for the four human decisions.
// Mirrors Hormbles' model: explosion -> production -> lbs -> ingredient needs -> net vs on-hand -> buy.

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
