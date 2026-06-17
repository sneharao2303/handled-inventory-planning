// scripts/verify.mjs — proves the canonical IP (lib/parsers.js + lib/engine.js) against real data.
// (A) PARSER + COMBINE tests run the REAL parsers on the raw grids in seed.json (uploaded snapshot).
// (B) ENGINE MATH tests run on FIXED production inputs (the verified May scenario).
import { parseElmers, parseBazzini, parsePalmer, parseSPG } from "../lib/parsers.js";
import { productionLbs, ingredientNeeds, buyList, combineInventories, combinedOnhandByName } from "../lib/engine.js";
import { suggestBuy, explainProduction, explainCombined, explainNeed, explainBuyRow } from "../lib/engine.js";
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
console.log(`\n${fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + fail + " CHECK(S) FAILED"}  (${pass} passed, ${fail} failed)\n`);
process.exit(fail === 0 ? 0 : 1);
