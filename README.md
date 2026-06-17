# Handled — Planning Tool

An ops-planning tool for consumer brands. Upload the raw files you already receive (co-man inventory, demand plan, 3PL finished-goods), and the app normalizes the mess, runs the supply + MRP math, and produces a **production plan** and an **ingredient buy-list** — reproducing, automatically, what a team does by hand across spreadsheets today.

Built and verified against a real anchor account's (Hormbles) May 2026 data. The numbers match their sheet to the penny.

## Quick start

```bash
npm install        # installs the dev server
npm start          # serves the app at http://localhost:3000
npm test           # runs the verification suite (proves the math matches)
```

`npm start` opens the working app. `npm test` proves the parsers + engine reproduce the real numbers (12 checks, all should pass).

## What's here

```
handled-planning-tool/
├── public/index.html     # the working app (zero-build, runs in any browser)
├── lib/
│   ├── parsers.js        # the 4 co-man normalizers + 3PL reader (VERIFIED)
│   └── engine.js         # production + MRP engine + Path-B suggestions (VERIFIED)
├── data/seed.json        # real reference data: code maps, recipes, ratios, BOM, opening inv
├── scripts/verify.mjs    # the verification suite (npm test)
├── BUILD_SPEC.md         # blueprint for the full hosted Next.js + DB version
└── CLAUDE.md             # context for Claude Code (read this first when extending)
```

## The flow

1. **Upload** the raw co-man inventory (pick which co-man), demand, and 3PL files. Preloaded with real demo data so it runs with no files.
2. **Review normalized inventory** — each ingredient found by supplier code; unmatched codes flagged, never dropped.
3. **Confirm decisions** — for the four fields that aren't yet rule-based (pallets, Other Volume, purchases, Actuals), the app **suggests a value with reasoning** and lets you **accept or enter manually**.
4. **Plan & buy-list** — production and buy-list with a "show the math" trace on every number; export to Excel.

## Extending it

This static app is the proven core. To grow it into the full hosted version (real DB, all four co-man uploads, saved runs, config UI), open `BUILD_SPEC.md` and `CLAUDE.md` — they give Claude Code everything needed to scaffold a Next.js + Prisma/SQLite app around the already-verified `lib/` logic.

**Do not rewrite `lib/parsers.js` or `lib/engine.js`** — they're tested against real data. Wire the app around them.
