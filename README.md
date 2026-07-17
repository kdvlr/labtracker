# Rakta Charitra

A self-hosted app to track your family's lab test results over time. Upload PDFs,
photos, or screenshots of lab reports; AI extracts the values; you review and
save. Everything — the database and the original files — lives in a single local
folder so it also serves as a backup you can reopen anytime.

## Features

- **Family profiles** — track results per person, switch between them in the sidebar.
- **AI extraction** — upload a PDF/photo/screenshot; the configured AI provider
  (Anthropic / OpenAI / Gemini) extracts test names, values, units, dates, and
  reference ranges. You review and correct before anything is saved.
- **Beautiful trends** — every test gets a card with a sparkline; click through to
  a full chart showing how the value has moved over years, with the reference
  range banded and out-of-range points flagged.
- **Unit handling** — same test in different units (mg/dL vs mmol/L, ng/mL vs
  nmol/L, etc.) is converted to a canonical unit so the trend is always
  comparable. The original reported value is preserved and shown alongside, and a
  unit toggle lets you view the chart in any known unit.
- **Reference ranges** — pulled from each report when present, with a sensible
  canonical fallback range per test used for consistent high/low flagging.
- **Ask AI** — select one or more tests and ask questions about the full history
  ("How has my cholesterol trended?"). The model only sees the structured data
  you select.
- **Local backup** — every uploaded file is stored under `./data/files` and
  reopenable from the Documents page.

## Run it

```bash
docker compose up --build
```

Then open http://localhost:8000. Data persists in `./data`.

Set your AI provider and API key on the **Settings** page (or preset a key via the
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars in
`docker-compose.yml`). Keys are stored in the local SQLite database and never
displayed back.

### Run without Docker (dev)

```bash
cd backend
pip install -r requirements.txt
LABTRACKER_DATA=../data uvicorn app.main:app --reload
```

## How it fits together

- **Backend** — FastAPI + SQLite (`backend/app`). The whole datastore is
  `data/labtracker.db` plus `data/files/`.
- **Frontend** — a self-contained single-page app (`backend/static`), no build
  step and no external CDNs, so it works fully offline. Charts are hand-drawn SVG.
- **AI** — `backend/app/ai.py` dispatches extraction and Q&A to the chosen
  provider. Anthropic uses the official SDK (default model `claude-opus-4-8`);
  OpenAI and Gemini use their REST APIs.

## Notes

This is a personal record-keeping and backup tool. It is **not** medical advice —
always consult a clinician for interpretation and decisions.
