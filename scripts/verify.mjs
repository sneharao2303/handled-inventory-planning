// scripts/verify.mjs — proves the canonical IP (lib/parsers.js + lib/engine.js) against real data.
// (A) PARSER + COMBINE tests run the REAL parsers on the raw grids in seed.json (uploaded snapshot).
// (B) ENGINE MATH tests run on FIXED production inputs (the verified May scenario).
import { parseElmers, parseBazzini, parsePalmer, parseSPG, parse3PL, routeTabName, routeWorkbookTabs } from "../lib/parsers.js";
import { productionLbs, ingredientNeeds, buyList, combineInventories, combinedOnhandByName, combineOpeningInventory, resolveOpeningInventory, classifyOpeningSku, finishedGoodsSkus } from "../lib/engine.js";
import { suggestBuy, explainProduction, explainCombined, explainNeed, explainBuyRow, explainOpening } from "../lib/engine.js";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(fs.readFileSync(path.join(__dir, "../data/seed.json"), "utf8"));
let pass = 0, fail = 0;
function check(label, got, expected, tol = 0.5) {
  const ok = Math.abs(got - expected) <= tol;
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(40)} ${String(got).padStart(12)}  (expected ${expected})`);
  ok ? pass++ : fail++;
}
function qtyOf(res, code) {
  const row = res.rows.find(r => r.code === code);
  return row ? row.qty : 0;
}

// Normalize all four co-mans with the REAL parsers, then combine into one on-hand picture.
const normalized = {
  elmers: parseElmers(SEED.raw_samples.elmers, SEED.elmers_map),
  bazzini: parseBazzini(SEED.raw_samples.bazzini, SEED.bazzini_map),
  palmer: parsePalmer(SEED.raw_samples.palmer),
  spg: parseSPG(SEED.raw_samples.spg),
};
const { combined } = combineInventories(normalized);

console.log("\n=== (A) PARSER TESTS — real uploaded snapshot, via lib/parsers.js ===");
console.log("\nElmers (spatial grid; qty located by Units/lbs header)");
check("Idaho (IN-CH302v2)", qtyOf(normalized.elmers, "IN-CH302v2"), 90669, 1);
check("Stockton (IN-MC301v2)", qtyOf(normalized.elmers, "IN-MC301v2"), 75920, 1);
check("Camogie (IN-PB303v2)", qtyOf(normalized.elmers, "IN-PB303v2"), 16600, 1);

console.log("\nBazzini (SUMIF lots by Hormbles code in col B)");
check("RM0130 (summed lots)", qtyOf(normalized.bazzini, "RM0130"), 2440, 1);
check("RM0137 (summed lots)", qtyOf(normalized.bazzini, "RM0137"), 129.66, 0.5);
check("RM0125 (summed lots)", qtyOf(normalized.bazzini, "RM0125"), 11609.83, 1);
check("RM0153 (summed lots)", qtyOf(normalized.bazzini, "RM0153"), 7773.02, 1);

console.log("\nPalmer (code in col C, strip unit text in col E)");
check("RM0130", qtyOf(normalized.palmer, "RM0130"), 19200, 0);
check("RM0131", qtyOf(normalized.palmer, "RM0131"), 314, 0);
check("RM0137", qtyOf(normalized.palmer, "RM0137"), 500, 0);

console.log("\nCombine inventories across co-mans (sum by code, keep per-source trace)");
// Per-source contributions to RM0130 (Plain Milk Crisp):
check("RM0130 from Bazzini", combined["RM0130"].sources.find(s => s.coman === "bazzini")?.qty || 0, 2440, 1);
check("RM0130 from Palmer", combined["RM0130"].sources.find(s => s.coman === "palmer")?.qty || 0, 19200, 1);
// Task's stated Bazzini+Palmer subtotal (the file ALSO carries RM0130 at Elmers this snapshot):
const rm0130_bz_pl = (combined["RM0130"].sources.find(s => s.coman === "bazzini")?.qty || 0)
  + (combined["RM0130"].sources.find(s => s.coman === "palmer")?.qty || 0);
check("RM0130 Bazzini+Palmer subtotal", rm0130_bz_pl, 21640, 1);
check("RM0130 from Elmers", combined["RM0130"].sources.find(s => s.coman === "elmers")?.qty || 0, 14704, 1);
// Honest holistic total = every co-man that carries the code (Elmers 14704 + Bazzini 2440 + Palmer 19200):
check("RM0130 combined total (all co-mans)", combined["RM0130"].qty, 36344, 1);

console.log("\nDemonstrate the fix — net need vs COMBINED on-hand, no phantom per-co-man buys");
{
  // Camogie Compound is stocked ONLY at Elmers (16,600); Palmer's file has none.
  const refprod = { "MCM1001-WIP": { minis_pallet: 30600, grams: 8 }, "MSF1002-WIP": { minis_pallet: 30600, grams: 8 } };
  const prodLbs = productionLbs({ palletsByWip: { "MCM1001-WIP": 11, "MSF1002-WIP": 11 }, refprod, barsLbs: { BPB3003: 5291.0943, BPB5003: 9866.3035 } });
  const needs = ingredientNeeds({ prodLbs, recipes: SEED.recipes, location: "Elmers" });
  const camogieNeed = needs["Camogie Compound"];
  const onhand = combinedOnhandByName(combined, SEED.ingredient_map);
  // BUG (per-co-man): run Palmer alone -> Camogie on-hand 0 -> spuriously buys ~14,200.
  const phantomBuy = suggestBuy({ ingredient: "Camogie Compound", need: camogieNeed, have: 0 }).value;
  check("Per-co-man (Palmer-alone) phantom buy", phantomBuy, 14200, 1);
  // FIXED (holistic): net against combined on-hand (Camogie at Elmers = 16,600) -> buy 0.
  const correctBuy = suggestBuy({ ingredient: "Camogie Compound", need: camogieNeed, have: onhand["Camogie Compound"] || 0 }).value;
  check("Holistic (combined on-hand) correct buy", correctBuy, 0, 0);
  check("Combined Camogie on-hand (code IN-PB303v2)", onhand["Camogie Compound"] || 0, 16600, 1);
}

console.log("\n=== (B) ENGINE MATH TESTS — fixed verified May scenario ===");
console.log("\nProduction + needs (Elmers May, 11 pallets)");
{
  const refprod = { "MCM1001-WIP": { minis_pallet: 30600, grams: 8 }, "MSF1002-WIP": { minis_pallet: 30600, grams: 8 } };
  const prodLbs = productionLbs({ palletsByWip: { "MCM1001-WIP": 11, "MSF1002-WIP": 11 }, refprod, barsLbs: { BPB3003: 5291.0943, BPB5003: 9866.3035 } });
  check("MC mini units", prodLbs["MCM1001-WIP__units"], 336600, 0);
  check("MC mini lbs", +prodLbs["MCM1001-WIP"].toFixed(2), 5936.61);
  const needs = ingredientNeeds({ prodLbs, recipes: SEED.recipes, location: "Elmers" });
  check("Camogie need", +needs["Camogie Compound"].toFixed(2), 14172.17);
  check("Idaho need", +needs["Idaho Compound"].toFixed(2), 5713.99);
  check("Cocoa Whey Crisp need", +needs["Cocoa Whey Crisp"].toFixed(2), 833.66);
  check("Stockton need", +needs["Stockton Compound"].toFixed(2), 5877.24);
  const bl = buyList({ needs, onhand: { "Cocoa Whey Crisp": 266 }, buyDecisions: { "Cocoa Whey Crisp": 800 } });
  const cocoa = bl.find(b => b.ingredient === "Cocoa Whey Crisp");
  check("Cocoa shortfall", cocoa.shortfall, 567.66, 1);
  check("Cocoa remaining after buy 800", cocoa.remaining, 232.34, 1);
}

console.log("\n=== (C) FULL HOLISTIC PIPELINE @ 11 pallets — locks the demo end-to-end ===");
console.log("\nCombine all 4 co-mans, run MC mini at 11 pallets, net vs combined inventory");
{
  const onhand = combinedOnhandByName(combined, SEED.ingredient_map);
  // Combined on-hand (proves the merge is what production nets against).
  check("Cocoa Whey Crisp combined (Elmers 728 + Palmer 314)", onhand["Cocoa Whey Crisp"] || 0, 1042, 1);
  check("Plain Milk Crisp combined (Elmers+Bazzini+Palmer)", onhand["Plain Milk Crisp"] || 0, 36344, 1);

  // Production at the verified 11 pallets (NOT a silent 1 -> would be 30,600 / 539.69 lbs).
  const refprod = { "MCM1001-WIP": { minis_pallet: 30600, grams: 8 }, "MSF1002-WIP": { minis_pallet: 30600, grams: 8 } };
  const prodLbs = productionLbs({ palletsByWip: { "MCM1001-WIP": 11, "MSF1002-WIP": 11 }, refprod, barsLbs: { BPB3003: 5291.0943, BPB5003: 9866.3035 } });
  check("MC mini units", prodLbs["MCM1001-WIP__units"], 336600, 0);
  check("MC mini lbs", +prodLbs["MCM1001-WIP"].toFixed(2), 5936.61);

  // Ingredient needs against combined inventory.
  const needs = ingredientNeeds({ prodLbs, recipes: SEED.recipes, location: "Elmers" });
  check("Camogie need", +needs["Camogie Compound"].toFixed(2), 14172.17);
  check("Plain Milk Crisp need", +needs["Plain Milk Crisp"].toFixed(2), 2951);
  check("Cocoa Whey Crisp need", +needs["Cocoa Whey Crisp"].toFixed(2), 833.66);
  check("Encapsulated Salt need", +needs["Encapsulated Salt"].toFixed(2), 185.63);
  check("Stockton need", +needs["Stockton Compound"].toFixed(2), 5877.24);
  check("Idaho need", +needs["Idaho Compound"].toFixed(2), 5713.99);

  // The holistic fix: combined stock covers every need -> ALL buys = 0. In particular Cocoa is NOT
  // bought (combined 1,042 > need 833.66) even though Elmers-alone 728 would look short.
  const bl = buyList({ needs, onhand });
  const cocoa = bl.find(b => b.ingredient === "Cocoa Whey Crisp");
  check("Cocoa Whey Crisp shortfall (combined)", cocoa.shortfall, 0, 0.01);
  check("Cocoa Whey Crisp suggested buy", suggestBuy({ ingredient: "Cocoa Whey Crisp", need: needs["Cocoa Whey Crisp"], have: onhand["Cocoa Whey Crisp"] }).value, 0, 0);
  const positiveBuys = bl.filter(b => b.shortfall > 0.5).length;
  check("Ingredients still short after combine", positiveBuys, 0, 0);
}

console.log("\n=== (D) TRANSPARENCY — every trace value equals the engine's computed value ===");
console.log("\nThe shown math comes from the same engine functions as the result (can't drift)");
{
  const refprod = { "MCM1001-WIP": { minis_pallet: 30600, grams: 8 }, "MSF1002-WIP": { minis_pallet: 30600, grams: 8 } };
  const prodLbs = productionLbs({ palletsByWip: { "MCM1001-WIP": 11, "MSF1002-WIP": 11 }, refprod, barsLbs: { BPB3003: 5291.0943, BPB5003: 9866.3035 } });
  const needs = ingredientNeeds({ prodLbs, recipes: SEED.recipes, location: "Elmers" });
  const onhand = combinedOnhandByName(combined, SEED.ingredient_map);

  // Production: explainProduction must equal productionLbs.
  const ep = explainProduction({ pallets: 11, minisPerPallet: 30600, grams: 8 });
  check("explainProduction units == engine", ep.units, prodLbs["MCM1001-WIP__units"], 0);
  check("explainProduction lbs == engine", +ep.lbs.toFixed(2), +prodLbs["MCM1001-WIP"].toFixed(2));

  // Combined cell: explainCombined value == combined map qty, and its trace sums to that value.
  const ec = explainCombined(combined["RM0130"], { elmers: "Elmers", bazzini: "Bazzini", palmer: "Palmer", spg: "SPG" });
  check("explainCombined value == combined.qty", ec.value, combined["RM0130"].qty, 0);
  const sumFromTrace = combined["RM0130"].sources.filter(s => s.qty).reduce((a, s) => a + s.qty, 0);
  check("explainCombined trace sums to value", +sumFromTrace.toFixed(2), +ec.value.toFixed(2), 0.01);

  // Needs: explainNeed must equal ingredientNeeds for each ingredient (its parts re-sum to the total).
  for (const ing of ["Stockton Compound", "Plain Milk Crisp", "Camogie Compound", "Cocoa Whey Crisp", "Encapsulated Salt", "Idaho Compound"]) {
    const en = explainNeed({ ingredient: ing, prodLbs, recipes: SEED.recipes, location: "Elmers" });
    check(`explainNeed == engine: ${ing}`, +en.value.toFixed(2), +needs[ing].toFixed(2), 0.02);
    const partsSum = en.parts.reduce((a, p) => a + p.contribution, 0);
    check(`explainNeed parts re-sum: ${ing}`, +partsSum.toFixed(2), +en.value.toFixed(2), 0.01);
  }

  // Buy row: the trace uses the engine row's exact numbers (no recompute).
  const bl = buyList({ needs, onhand });
  const cocoaRow = bl.find(b => b.ingredient === "Cocoa Whey Crisp");
  const eb = explainBuyRow(cocoaRow);
  check("explainBuyRow trace is non-empty", eb.buyTrace.length > 0 ? 1 : 0, 1, 0);
  check("explainBuyRow covered => buy 0", cocoaRow.buy, 0, 0);
}

console.log("\n=== (E) 3PL OPENING INVENTORY — reproduce the client's Total Inventory OH ===");
console.log("\nparse3PL (SUMIF eaches by SKU) on FST + Green Rabbit, then combine across warehouses");
{
  const gr = parse3PL(SEED.raw_samples.green_rabbit);
  const fst = parse3PL(SEED.raw_samples.fst);
  const grBCM = gr.rows.find(r => r.sku === "BCM3001");
  const fstBCM = fst.rows.find(r => r.sku === "BCM3001");
  check("Green Rabbit BCM3001 (summed rows)", grBCM ? grBCM.qty : 0, 23988, 0);
  check("FST BCM3001", fstBCM ? fstBCM.qty : 0, 247608, 0);
  // Green Rabbit BPB2003 sums two rows (19,656 + 48).
  const grPB = gr.rows.find(r => r.sku === "BPB2003");
  check("Green Rabbit BPB2003 (19,656 + 48)", grPB ? grPB.qty : 0, 19704, 0);

  // Combine: opening inventory = GR + FST per SKU = the exact Total Inventory OH value.
  const { opening } = combineOpeningInventory({ fst, greenRabbit: gr });
  check("Opening BCM3001 = GR 23,988 + FST 247,608", opening["BCM3001"].qty, 271596, 0);
  // Matches the standalone opening_inv stand-in extracted from Total Inventory OH.
  const standin = (SEED.opening_inv.find(o => o.sku === "BCM3001") || {}).qty;
  check("Opening BCM3001 == opening_inv stand-in", opening["BCM3001"].qty, standin, 0);

  // explainOpening trace value equals the combined value (transparency, no drift).
  const eo = explainOpening(opening["BCM3001"], { fst: "FST", green_rabbit: "Green Rabbit" });
  check("explainOpening value == opening.qty", eo.value, opening["BCM3001"].qty, 0);
  const sumFromTrace = opening["BCM3001"].sources.filter(s => s.qty).reduce((a, s) => a + s.qty, 0);
  check("explainOpening trace sums to value", sumFromTrace, eo.value, 0);

  // Header is detected (FST/GR start on different rows) — every SKU below the header parses, the note row above does not.
  check("FST distinct SKUs parsed (header detected)", fst.rows.length, 19, 0);
  check("FST has no non-data rows leaked", fst.rows.some(r => /adjust/i.test(r.sku)) ? 1 : 0, 0, 0);

  // 3PL opening inventory is finished goods (bar SKUs), DISTINCT from co-man raw inventory (RM/IN codes).
  const anyRawCode = Object.keys(opening).some(s => /^(RM|IN-)/i.test(s));
  check("Opening inv holds NO raw-material codes (kept separate)", anyRawCode ? 1 : 0, 0, 0);

  // code map path: translate a warehouse-SKU-only export, and flag an unresolved code.
  const mapped = parse3PL([["x"], [null, "SKU Code", "c", "s", "Qty (eaches)", "wsku"], [null, "989-X", 1, null, 500, "x"], [null, "989-Y", 1, null, 7, "y"]], { codeMap: { "989-X": "BCM3001" } });
  const mb = mapped.rows.find(r => r.sku === "BCM3001");
  check("3PL codeMap translates warehouse SKU", mb ? mb.qty : 0, 500, 0);
  check("3PL flags unresolved SKU (not dropped)", mapped.flags.some(f => f.includes("989-Y")) ? 1 : 0, 1, 0);
}

console.log("\n=== (F) OPENING-INVENTORY SOURCE SELECTION — 3-tier priority + fallback ===");
console.log("\nuploads → demo → opening_inv stand-in; never empty/zero for missing 3PL data");
{
  const oi = SEED.opening_inv;
  const standinBCM = (oi.find(o => o.sku === "BCM3001") || {}).qty;

  // Tier 2 (demo): FST+GR sample grids present -> compute from them.
  const demo = resolveOpeningInventory({ demoFst: SEED.raw_samples.fst, demoGr: SEED.raw_samples.green_rabbit, openingInv: oi });
  check("demo: source == 'demo'", demo.source === "demo" ? 1 : 0, 1, 0);
  check("demo: BCM3001 opening = 271,596", demo.opening["BCM3001"].qty, 271596, 0);
  check("demo: cross-check BCM3001 matches reference", demo.crossCheck["BCM3001"].match ? 1 : 0, 1, 0);

  // Tier 1 (uploads): uploaded grids take priority over demo.
  const up = resolveOpeningInventory({ uploadFst: SEED.raw_samples.fst, uploadGr: SEED.raw_samples.green_rabbit, demoFst: SEED.raw_samples.fst, demoGr: SEED.raw_samples.green_rabbit, openingInv: oi });
  check("uploads: source == 'uploads'", up.source === "uploads" ? 1 : 0, 1, 0);
  check("uploads: BCM3001 opening = 271,596", up.opening["BCM3001"].qty, 271596, 0);

  // Tier 3 (fallback): NO 3PL data -> fall back to opening_inv, never empty/zero, never crashes.
  const fb = resolveOpeningInventory({ openingInv: oi });
  check("fallback: source == 'standin'", fb.source === "standin" ? 1 : 0, 1, 0);
  check("fallback: BCM3001 resolves to opening_inv (not 0)", fb.opening["BCM3001"].qty, standinBCM, 0);
  check("fallback: opening map is non-empty", Object.keys(fb.opening).length > 0 ? 1 : 0, 1, 0);

  // Cross-check surfaces divergence (quiet warning, not a crash): bend the reference for one SKU.
  const bentRef = oi.map(o => o.sku === "BCM3001" ? { ...o, qty: 999 } : o);
  const div = resolveOpeningInventory({ demoFst: SEED.raw_samples.fst, demoGr: SEED.raw_samples.green_rabbit, openingInv: bentRef });
  check("cross-check flags divergence (match=false)", div.crossCheck["BCM3001"].match ? 1 : 0, 0, 0);
  check("cross-check still computes the real total", div.crossCheck["BCM3001"].computed, 271596, 0);
}

console.log("\n=== (G) 3PL RECONCILIATION — complete grids reconcile to Total Inventory OH (0 divergences) ===");
console.log("\nEvery finished-goods SKU the FST+GR exports carry must equal its opening_inv reference");
{
  const res = resolveOpeningInventory({ demoFst: SEED.raw_samples.fst, demoGr: SEED.raw_samples.green_rabbit, openingInv: SEED.opening_inv });
  // The cross-check covers every SKU the exports carry that also exists in the reference.
  const checked = Object.keys(res.crossCheck);
  const divergent = checked.filter(s => !res.crossCheck[s].match);
  check("SKUs reconciled (FST+GR present & in reference)", checked.length > 0 ? 1 : 0, 1, 0);
  check("DIVERGENCES (computed FST+GR != reference)", divergent.length, 0, 0);
  if (divergent.length) divergent.forEach(s => console.log(`     ✗ ${s}: computed ${res.crossCheck[s].computed} vs ref ${res.crossCheck[s].reference}`));

  // The 4 SKUs that diverged before the GR data was completed now match exactly (FST + previously-missing GR).
  check("BMC5001 reconciled (FST 161,280 + GR 60,120)", res.opening["BMC5001"].qty, 221400, 0);
  check("BSF3002 reconciled (FST 148,608 + GR 89,388)", res.opening["BSF3002"].qty, 237996, 0);
  check("BPB5003 reconciled (FST 50,112 + GR 11,952)", res.opening["BPB5003"].qty, 62064, 0);
  check("BPB3003 reconciled (FST 33,696 + GR 24,492)", res.opening["BPB3003"].qty, 58188, 0);
  check("BCM3001 unchanged", res.opening["BCM3001"].qty, 271596, 0);

  // Complete grids present (GR 32 rows, FST 29 rows) — the root-cause data was incomplete before.
  check("Green Rabbit grid complete (rows)", SEED.raw_samples.green_rabbit.length, 32, 0);
  check("FST grid complete (rows)", SEED.raw_samples.fst.length, 29, 0);
}

console.log("\n=== (H) 3PL DISPLAY FILTER — finished-goods only (packaging/junk excluded; math unchanged) ===");
console.log("\nclassifyOpeningSku groups SKUs for display; the combine/reconciliation totals are untouched");
{
  const fin = finishedGoodsSkus(SEED);
  // Finished goods (incl. real-but-zero bars kept via family prefix).
  check("BCM3001 classified finished", classifyOpeningSku("BCM3001", fin) === "finished" ? 1 : 0, 1, 0);
  check("BCC3004 (zero, real) classified finished", classifyOpeningSku("BCC3004", fin) === "finished" ? 1 : 0, 1, 0);
  check("BVAR200 (zero, real) classified finished", classifyOpeningSku("BVAR200", fin) === "finished" ? 1 : 0, 1, 0);
  // Packaging excluded.
  check("PK-MC classified packaging", classifyOpeningSku("PK-MC", fin) === "packaging" ? 1 : 0, 1, 0);
  check("HCINSER classified packaging", classifyOpeningSku("HCINSER", fin) === "packaging" ? 1 : 0, 1, 0);
  // Junk / non-SKU artifacts excluded (look-alike BB101 too).
  check("'Wafer S' classified unknown", classifyOpeningSku("Wafer S", fin) === "unknown" ? 1 : 0, 1, 0);
  check("'Double-' classified unknown", classifyOpeningSku("Double-", fin) === "unknown" ? 1 : 0, 1, 0);
  check("'14 BOXE' classified unknown", classifyOpeningSku("14 BOXE", fin) === "unknown" ? 1 : 0, 1, 0);
  check("'BB101' classified unknown (look-alike)", classifyOpeningSku("BB101", fin) === "unknown" ? 1 : 0, 1, 0);

  // Group the actual combine output: finished-goods table excludes all packaging + junk.
  const { opening } = combineOpeningInventory({ fst: parse3PL(SEED.raw_samples.fst), greenRabbit: parse3PL(SEED.raw_samples.green_rabbit) });
  const g = { finished: 0, packaging: 0, unknown: 0 };
  for (const sku of Object.keys(opening)) g[classifyOpeningSku(sku, fin)]++;
  check("finished SKUs displayed", g.finished, 18, 0);
  check("packaging SKUs filtered out", g.packaging, 6, 0);
  check("junk/non-SKU rows filtered out", g.unknown, 4, 0);
  const noPkgOrJunk = Object.keys(opening).filter(s => classifyOpeningSku(s, fin) === "finished").every(s => !/^(PK-|HC)/i.test(s));
  check("displayed table has NO packaging codes", noPkgOrJunk ? 1 : 0, 1, 0);

  // Math unchanged: the combine still carries every row, and BCM3001 still reconciles to 271,596.
  check("combine still carries all 28 SKUs (math untouched)", Object.keys(opening).length, 28, 0);
  check("BCM3001 total still 271,596 (filter is display-only)", opening["BCM3001"].qty, 271596, 0);
}

console.log("\n=== (I) BUY/ACTUALS EDIT — manual override at 0 shortfall + actuals net into on-hand ===");
console.log("\nUI single-source-of-truth behavior verified at the engine-contract level (math unchanged)");
{
  const needs = { "Cocoa Whey Crisp": 833.66 };
  const onhand = { "Cocoa Whey Crisp": 1042 }; // combined: covers need -> no shortfall
  // No decision -> suggested buy is 0 (covered), remaining = on-hand - need.
  const base = buyList({ needs, onhand }).find(b => b.ingredient === "Cocoa Whey Crisp");
  check("covered: shortfall 0", base.shortfall, 0, 0.01);
  check("covered: suggested buy 0", base.buy, 0, 0);
  check("covered: remaining = on-hand - need", base.remaining, 208.34, 0.01);
  // Manual override of 800 is honored EVEN with no shortfall; remaining recomputes live.
  const manual = buyList({ needs, onhand, buyDecisions: { "Cocoa Whey Crisp": 800 } }).find(b => b.ingredient === "Cocoa Whey Crisp");
  check("manual buy 800 honored at 0 shortfall", manual.buy, 800, 0);
  check("remaining recomputes (1042 - 833.66 + 800)", manual.remaining, 1008.34, 0.01);
  // A manual actual (in-transit correction) adds to combined on-hand and raises remaining.
  const withActual = buyList({ needs, onhand, actuals: { "Cocoa Whey Crisp": 100 } }).find(b => b.ingredient === "Cocoa Whey Crisp");
  check("actual +100 nets into on-hand (remaining 308.34)", withActual.remaining, 308.34, 0.01);
  // The reusable known-manual-value annotation carries Tom's 800 + the open question (data, not a computed number).
  const km = SEED.known_manual_buys && SEED.known_manual_buys["Cocoa Whey Crisp"];
  check("Cocoa known-manual value = 800", km ? km.value : 0, 800, 0);
  check("Cocoa known-manual records an open question", km && km.question && km.hints ? 1 : 0, 1, 0);
}

console.log("\n=== (J) COMBINED WORKBOOK — route tabs by name; identical downstream to separate files ===");
console.log("\nA single workbook's tabs route to the right parser; skip unknown tabs; same combine result");
{
  // Tab-name routing (case-insensitive substring; skip-patterns win over parser matches).
  check("'Elmer' → elmers", routeTabName("Elmer") === "elmers" ? 1 : 0, 1, 0);
  check("'Elmers' → elmers", routeTabName("Elmers") === "elmers" ? 1 : 0, 1, 0);
  check("'Bazzini' → bazzini", routeTabName("Bazzini") === "bazzini" ? 1 : 0, 1, 0);
  check("'Palmer' → palmer", routeTabName("Palmer") === "palmer" ? 1 : 0, 1, 0);
  check("'Superior Pack Group' → spg", routeTabName("Superior Pack Group") === "spg" ? 1 : 0, 1, 0);
  check("'SPG' → spg", routeTabName("SPG") === "spg" ? 1 : 0, 1, 0);
  check("'FST' → fst", routeTabName("FST") === "fst" ? 1 : 0, 1, 0);
  check("'Green Rabbit' → green_rabbit", routeTabName("Green Rabbit") === "green_rabbit" ? 1 : 0, 1, 0);
  // The tricky one: contains "fst" but must SKIP (skip-pattern beats the fst match).
  check("'FST and GR portal logins' → skip (null)", routeTabName("FST and GR portal logins") === null ? 1 : 0, 1, 0);

  // CO-MAN combined workbook that ALSO (wrongly) contains stray FST / Green Rabbit / portal tabs.
  const tabs = {
    "Elmer": SEED.raw_samples.elmers,
    "Bazzini": SEED.raw_samples.bazzini,
    "Palmer": SEED.raw_samples.palmer,
    "Superior Pack Group": SEED.raw_samples.spg,
    "FST": SEED.raw_samples.fst,                 // stray 3PL tab — must be IGNORED here, not routed
    "Green Rabbit": SEED.raw_samples.green_rabbit,// stray 3PL tab — must be IGNORED here, not routed
    "FST and GR portal logins": [["Portal", "URL"], ["FST", "https://fst.example/login"]],
  };
  const r = routeWorkbookTabs(tabs);
  check("routes ONLY 4 co-man tabs", r.detected.length, 4, 0);
  check("FST/GR tabs bucketed as 3PL (ignored here)", r.threePL.length, 2, 0);
  check("routed has NO fst key (3PL not pulled from workbook)", r.routed.fst === undefined ? 1 : 0, 1, 0);
  check("routed has NO green_rabbit key", r.routed.green_rabbit === undefined ? 1 : 0, 1, 0);
  check("skipped the portal-logins tab", r.skipped.includes("FST and GR portal logins") ? 1 : 0, 1, 0);
  check("no missing co-mans", r.missing.length, 0, 0);

  // Each routed co-man tab parses to the SAME normalized result as the separate-file path.
  const elm = parseElmers(r.routed.elmers, SEED.elmers_map);
  check("routed Elmers: Idaho 90,669", elm.rows.find(x => x.code === "IN-CH302v2").qty, 90669, 1);
  check("routed Elmers: Stockton 75,920", elm.rows.find(x => x.code === "IN-MC301v2").qty, 75920, 1);
  check("routed Elmers: Camogie 16,600", elm.rows.find(x => x.code === "IN-PB303v2").qty, 16600, 1);
  check("routed Bazzini: RM0130 2,440", parseBazzini(r.routed.bazzini, SEED.bazzini_map).rows.find(x => x.code === "RM0130").qty, 2440, 1);
  check("routed Palmer: RM0130 19,200", parsePalmer(r.routed.palmer).rows.find(x => x.code === "RM0130").qty, 19200, 0);

  // Both co-man modes produce identical co-man combined inventory.
  const sep = combineInventories({ elmers: parseElmers(SEED.raw_samples.elmers, SEED.elmers_map), bazzini: parseBazzini(SEED.raw_samples.bazzini, SEED.bazzini_map), palmer: parsePalmer(SEED.raw_samples.palmer), spg: parseSPG(SEED.raw_samples.spg) });
  const comb = combineInventories({ elmers: parseElmers(r.routed.elmers, SEED.elmers_map), bazzini: parseBazzini(r.routed.bazzini, SEED.bazzini_map), palmer: parsePalmer(r.routed.palmer), spg: parseSPG(r.routed.spg) });
  check("combined-mode RM0130 == separate-mode (36,344)", comb.combined["RM0130"].qty, sep.combined["RM0130"].qty, 0);
  check("combined-mode SKU count == separate-mode", Object.keys(comb.combined).length, Object.keys(sep.combined).length, 0);

  // 3PL ALWAYS comes from the dedicated FST/GR uploads (or fallback) — NEVER from the co-man workbook.
  // No double-count: opening built from the separate FST/GR samples = 271,596, even though the workbook
  // also had FST/GR tabs (which were ignored). BCM3001 reflects ONE FST + ONE GR, not doubled.
  const opening = combineOpeningInventory({ fst: parse3PL(SEED.raw_samples.fst), greenRabbit: parse3PL(SEED.raw_samples.green_rabbit) });
  check("3PL opening BCM3001 = 271,596 (single source, no double-count)", opening.opening["BCM3001"].qty, 271596, 0);

  // Missing co-man detection: a workbook lacking Palmer flags it (does not error).
  const r2 = routeWorkbookTabs({ "Elmer": SEED.raw_samples.elmers, "Bazzini": SEED.raw_samples.bazzini, "SPG": SEED.raw_samples.spg });
  check("missing Palmer flagged", r2.missing.includes("palmer") ? 1 : 0, 1, 0);
}
console.log(`\n${fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + fail + " CHECK(S) FAILED"}  (${pass} passed, ${fail} failed)\n`);
process.exit(fail === 0 ? 0 : 1);
