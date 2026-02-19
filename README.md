# Roblox Avatar 3D Viewer

A browser-based 3D viewer for inspecting Roblox avatar rigs, layered clothing, and cage deformers, now with a backend benchmark pipeline, retries, metrics, and SLO alerting.

![Screenshot](https://img.shields.io/badge/Three.js-r167-blue)

## What Changed

- Frontend refactor from single-file inline app to split architecture:
  - `index.html` (shell + layout)
  - `styles/app.css` (styles)
  - `js/viewer-app.js` (viewer logic)
  - `js/services/backend-api.js` (API client)
  - `js/ui/ops-panel.js` (operations UI)
  - `js/main.js` (module bootstrap)
- Backend service (`server/`) for:
  - manifest serving (`/api/manifest`)
  - asynchronous benchmark jobs (`/api/pipeline/benchmark`)
  - retry/backoff queue workers
  - rolling metrics (`/api/metrics`)
  - SLO evaluation + alert lifecycle (`/api/health`, `/api/slo`, `/api/alerts`)
- New in-app Operations panel for queueing backend jobs and monitoring queue depth, API p95, success rate, retries, and active alerts.

## Features

- **Inspector**: Per-mesh render stats (triangles, vertices, draw calls, GPU memory, materials, textures, bones)
- **Stress Test**: Clone avatars (1-49x) with FPS, CPU/GPU render time, heap, and frame budget visualization
- **Budget Mode**: Budget risk summary by geometry and memory thresholds
- **Report Mode**: Batch benchmark reporting with CSV/JSON export
- **Procedural Animations**: Idle, Run, and Jump (no animation files)
- **Visibility Overlay**: Front-facing triangle heatmap
- **LOD Preview**: Side-by-side LOD inspection
- **Ops Control Plane**: Backend queue jobs, retries, SLO/alerts, and health monitoring

## Quick Start

```bash
cd avatar_viewer
npm run dev
```

Open [http://localhost:8090](http://localhost:8090)

## Project Structure

```text
avatar_viewer/
├── index.html
├── manifest.json
├── styles/
│   └── app.css
├── js/
│   ├── main.js
│   ├── viewer-app.js
│   ├── services/
│   │   └── backend-api.js
│   └── ui/
│       └── ops-panel.js
├── server/
│   ├── index.js
│   ├── job-queue.js
│   ├── job-store.js
│   ├── logger.js
│   ├── metrics.js
│   ├── pipeline.js
│   └── slo.js
├── data/
│   └── jobs/               # runtime job snapshots
├── models/
│   ├── rigs/
│   ├── clothing/
│   └── cage_deformers/
├── convert_assets.py
└── README.md
```

## Backend API

- `GET /api/health` - process health, queue snapshot, rolling metrics, SLO state, active alerts
- `GET /api/manifest` - manifest payload consumed by frontend
- `POST /api/pipeline/benchmark` - enqueue benchmark pipeline job
- `GET /api/pipeline/jobs?limit=20` - recent jobs
- `GET /api/pipeline/jobs/:id` - detailed job status/result
- `GET /api/slo` - SLO evaluation against rolling metrics
- `GET /api/alerts` - active and recent alert objects
- `GET /api/metrics` - Prometheus-style text metrics

### Example: enqueue a benchmark job

```bash
curl -sS -X POST http://localhost:8090/api/pipeline/benchmark \
  -H 'Content-Type: application/json' \
  -d '{"categories":["rigs"],"maxModels":8,"shards":2,"injectTransientFailure":false}'
```

## Queue, Retry, and SLO Design

- **Queue model**: in-process async workers with configurable concurrency (`JOB_CONCURRENCY`)
- **Retry policy**: exponential backoff (`JOB_BASE_RETRY_MS`) up to `JOB_MAX_ATTEMPTS`
- **Persistence**: each job state is written to `data/jobs/<id>.json`
- **Rolling metrics window**: 15 minutes for API and job metrics
- **SLO checks**:
  - API availability >= 99.5%
  - API latency p95 <= 250ms
  - Job success rate >= 99%
  - Queue wait p95 <= 2000ms

## Environment Variables

- `PORT` (default `8090`)
- `JOB_CONCURRENCY` (default `2`)
- `JOB_MAX_ATTEMPTS` (default `3`)
- `JOB_BASE_RETRY_MS` (default `600`)

## Build Tool (Optional)

`convert_assets.py` converts FBX source assets into `.glb` and regenerates `manifest.json`.

Requirements:

- Python 3.9+
- [assimp](https://github.com/assimp/assimp) CLI (`brew install assimp` on macOS)
- Source FBX files (not included)

## License

MIT
