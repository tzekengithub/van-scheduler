# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Van booking management system built with Next.js 16, React 19, Drizzle ORM, PostgreSQL (Neon), and a separate Flask/PyMuPDF microservice for PDF text extraction. The AI scheduling layer uses OpenRouter (Gemini 2.5 Pro).

## Common Commands

All commands run from the project root:

```bash
npm run dev          # Start dev server at http://localhost:3000
npm run build        # Production build (always run before pushing)
npm run lint         # ESLint
npm run db:push      # Apply schema changes to Neon database
npm run db:generate  # Generate Drizzle migration files
```

**Parser / scheduler unit tests:**
```bash
npx ts-node --project tsconfig.scripts.json scripts/test-parser.ts
npx ts-node --project tsconfig.scripts.json scripts/test-scheduler.ts   # full E2E with DB
```

**PDF microservice** (runs separately, needed for PDF upload):
```bash
cd pdf-service
pip install -r requirements.txt
python main.py       # Listens on PORT (default 8080)
# Or: gunicorn -w 4 -b 0.0.0.0:8080 main:app
```

## Environment

Copy `.env.example` to `.env.local` and fill in values:
```
DATABASE_URL=postgresql://user:password@host/dbname
OPENROUTER_API_KEY=sk-or-v1-...
NEXT_PUBLIC_PDF_SERVICE_URL=https://your-railway-app.up.railway.app
NEXT_PUBLIC_APP_URL=                  # defaults to http://localhost:3000
COMPANY_NAME=                         # shown in page title and AI system prompt
COMPANY_PHONE=                        # lines containing this are stripped from parsed PDFs
COMPANY_EMAIL=
COMPANY_ADDRESS=
LOCATIONS=KL,Penang,JB,...            # comma-separated; populates location dropdowns
```

`NEXT_PUBLIC_PDF_SERVICE_URL` is exposed to the browser (health check / cold-start countdown). The PDF service is deployed on Railway.

## Architecture

### Two Upload Flows

1. **`/api/upload`** — Parses PDFs directly on the server, inserts, then runs the **rules engine** (`recheckAllVans`). Used for direct uploads without preview.
2. **`/api/preview` → `/api/insert`** — Client calls `/api/preview` first to show a confirmation UI, then `/api/insert` with the pre-parsed JSON. `/api/insert` also runs the **rules engine** (`recheckAllVans`).

Both routes stream SSE events (`parsed`, `progress`, `recheck`, `recheck_log`, `ai_summary`, `done`, `error`).

### Scheduling Layer: Two Engines

**Rules engine** (`lib/recheck.ts` + `lib/reassign.ts`):
- `recheckAllVans()` is a 7-step orchestrator: reset auto bookings → `runReassign()` → enforce invoice-van consistency → fix same-day multi-vehicle conflicts → eliminate double-bookings → mark remaining as outsourced.
- `runReassign()` is priority-based with a two-pass bump algorithm: day_trip > one_way_ride > round_trip > trip. Day trips can displace lower-priority trips; bumped bookings get a second pass without bumping rights.

**AI scheduler** (`lib/ai-scheduler.ts`):
- `aiRecheckAllVans(logger?, newIds?)` sends all unprotected bookings to Gemini 2.5 Pro via OpenRouter in batches of 50 (CHUNK_SIZE).
- When `newIds` is provided (insert flow), each booking in the payload carries `isNew: true/false`. The AI only freely assigns `isNew=true` bookings; existing assignments (`isNew=false`) are only moved when a new higher-priority trip needs that exact van+date with no free alternative.
- Falls back to `runReassign()` per-batch if the API call fails.
- Active scheduling rules from the `schedulingRules` DB table are appended to every AI request.

**Priority tiers** (highest → lowest): Multi-day / `day_trip` → Standard (`trip`, `round_trip`, `tpri`) → One-way (`one_way_ride`). Singapore/Thailand-capable trips can bump any Malaysia-only trip to claim a capable van.

### Protection / Locking Rules

- `manualChange = 1` — hard lock; never touched by any automated process.
- `inHouseOrOutsourced = 'O'` with non-empty `outsourcedCompany` — confirmed outsource; never reassigned.
- `vehicleCategory = 'Car'` — always outsourced; never assigned a fleet van.
- `isAlphardTrip = 1` — only Toyota Alphard vans; never regular vans (and vice versa).

### Database Schema (`drizzle/schema.ts`)

Three tables:
- **`vans`**: `id`, `vanNumber` (plate), `driverName`, `driverContact`, `singaporeEnabled`, `thailandEnabled`, `maxPaxCapacity`, `location`, `vehicleType`
- **`bookings`**: all invoice/trip fields plus `vanId` (FK), `manualChange`, `inHouseOrOutsourced`, `outsourcedCompany`, `tripType`, `isAlphardTrip`, `vehicleCategory`, `vehicleIndex`, `numberOfVehicles`
- **`schedulingRules`**: user-defined natural-language rules injected into every AI prompt

### API Routes (`app/api/`)

| Route | Methods | Purpose |
|---|---|---|
| `/api/bookings` | GET, POST | List (filter by day/month/year) or create blank booking |
| `/api/bookings/[id]` | PATCH, DELETE | Update or delete single booking; DELETE triggers full recheck |
| `/api/bookings/[id]/reassign` | POST | Re-run `runReassign([id])` for a single booking |
| `/api/bookings/duplicates` | DELETE | SQL window-function dedup on (invoiceNo, travelDate, amount) |
| `/api/vans` | GET, POST, PATCH, DELETE | Van CRUD; POST/DELETE trigger reassign |
| `/api/upload` | POST | Parse PDFs → insert → rules engine recheck (SSE) |
| `/api/insert` | POST | Accept pre-parsed JSON → insert → AI recheck (SSE) |
| `/api/preview` | POST | Parse PDFs without inserting (preview UI) |
| `/api/reassign` | POST | Manual "Recheck" button — runs full `recheckAllVans` rules engine (SSE) |
| `/api/chat` | POST | Agentic AI chat with 4 tools: `assign_van`, `set_outsource`, `save_scheduling_rule`, `trigger_recheck` (SSE) |
| `/api/scheduling-rules` | GET, POST, DELETE | CRUD for persistent scheduling rules |
| `/api/clear` | POST | Truncate all bookings |
| `/api/seed` | POST | Insert 3 placeholder vans (VAN-001..003) if not present |

### Library (`lib/`)

- **`db.ts`** — Drizzle + Neon client
- **`pdf-parser.ts`** — Calls `PDF_SERVICE_URL/parse`, then `parseRawText()` extracts invoice rows. Detects trip type, vehicle category (Van/Alphard/Car), expands multi-vehicle rows into separate bookings. Car trips are auto-outsourced.
- **`van-assignment.ts`** — `smartAssignVan()` uses OpenRouter for single-booking decisions with hard constraints and soft preferences.
- **`recheck.ts`** — 7-step full schedule orchestrator (rules engine).
- **`reassign.ts`** — Priority-based two-pass bump algorithm called by recheck.
- **`config.ts`** — Single source of truth for company identity and location list, read from env vars (`COMPANY_NAME`, `COMPANY_PHONE`, `LOCATIONS`). Consumed by `pdf-parser.ts` (line-skip filter), `ai-scheduler.ts` (system prompt), `layout.tsx` (page title), and `page.tsx` (location dropdown). Change company branding here, not in individual files.
- **`ai-scheduler.ts`** — Batched AI scheduler for full or targeted recheck. CHUNK_SIZE is 50.
- **`chat-context.ts`** — `buildScheduleContext()` formats fleet + booking data for the chat LLM (capped at 60 days / 150 bookings).
- **`scheduling-rules.ts`** — CRUD helpers for the `schedulingRules` table.

### PDF Microservice (`pdf-service/`)

Standalone Flask app deployed on Railway. `POST /parse` accepts raw PDF bytes, returns `{ text }` using PyMuPDF with spatial sorting. `GET /health` used by the frontend cold-start countdown. `POST /debug` returns line-by-line breakdown.

### Pages (`app/`)

- `/` — Van/driver management + bulk operations (seed, clear, recheck, AI log display)
- `/daily-jobs` — Bookings for a selected date; PDF upload; inline editing; manual reassign per row
- `/all-jobs` — All bookings with search/sort/filter; inline editing; drag-and-drop van assignment
- `/van-schedule` — Monthly calendar grid (rows = vans, columns = days); conflict sidebar; drag-and-drop

Global upload state (modal open/close, preview rows, SSE progress, AI reasoning) lives in `app/upload-context.tsx` wrapping the entire app. The AI chat sidebar (`ChatPanel`) is rendered in the root layout.

## Key Design Decisions

- **Node.js runtime** forced on `/api/upload` and `/api/insert` because `pdf-parse` requires Node.js `fs`/`Buffer`.
- **PyMuPDF in Python** — no JS equivalent; Next.js calls it via HTTP.
- **`manualChange` flag** prevents auto-reassignment from overwriting user edits during re-uploads or rechecks.
- **`isNew` flag in AI payload** — when inserting new bookings, existing assignments are flagged `isNew=false` so the AI only displaces them if a new higher-priority trip forces it, preventing unnecessary reshuffling.
- **Chunked AI batching** — 50 bookings per OpenRouter request (CHUNK_SIZE); committed van+date slots are passed as context between chunks so the AI never double-books across batches.
- **Invoice continuity exceptions** — one-way trips with a multi-day gap between legs don't require the same van; outsourced legs don't carry continuity to subsequent legs.
