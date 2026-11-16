# telemetry-sim

A 2D/3D vehicle telemetry simulator built with TypeScript and Vite. It imports CSV driving logs, reconstructs vehicle dynamics in a headless physics core, and visualizes trips, incidents, and telemetry envelopes in the browser.

## Current Features (Phase 1 — Headless Physics Core)

All physics and scoring calculations are implemented in dependency-free TypeScript (`src/core/`), compatible with both Node.js headless tests and Web Workers:

- **CSV Telemetry Parser** (`src/core/parser.ts`): Parses `# key=value` metadata headers, auto-detects milli-G scaling (`max(|accel|) > 15`), filters sensor spikes, and extracts dynamic extra channels into `extras`.
- **Quasi-Static Load Transfer** (`src/core/loadTransfer.ts`): Computes 4-wheel vertical tire loads (`fzFL`, `fzFR`, `fzRL`, `fzRR`) with strict mass conservation (`Fz_total == m * g`), axle roll distribution (`frontRollShare`), axle-split wheel-lift guards, and low-speed steering damping (`w_u`).
- **Dynamic Kamm Friction Limits** (`src/core/kamm.ts`): Parses commercial tire sizes (e.g., `195/55 R16` → outer radius in meters) and computes dynamic acceleration, braking, and lateral G limits enforcing `brakeLimit >= accelLimit`.
- **Incident Scoring & Slip Detection** (`src/core/scoring.ts`): Detects oversteer/counter-steering slip under ISO 8855 conventions, clusters incidents with a `1.0 s` debounce window (prioritizing `points`, then `excessRatio`), and validates the `300 s` minimum moving-data rule.

## Sign Conventions (ISO 8855 / ENU)

- `+ax`: forward acceleration | `-ax`: braking
- `+ay`: left turn (`ay = -compensatedLatG * 9.80665` for LABSIS inputs)
- `omegaZ`: counter-clockwise yaw rate in `rad/s`

## Getting Started

### Prerequisites

- Node.js (v22+ with native TypeScript execution, tested on v26)

### Install & Run

```bash
npm install
npm run dev
```

### Typecheck & Build

```bash
npm run build
```

### Run Headless Unit Tests

```bash
node --test test/*.test.ts
```

## Roadmap

- [x] **Phase 0 & 1:** Project setup, core types, CSV parser, load transfer, dynamic Kamm limits, and incident scoring
- [ ] **Phase 2:** ENU projection (`wgs84ToEnu`), tunnel dead-reckoning, and 60+ FPS Hermite interpolator
- [ ] **Phase 3:** Web Worker pipeline, MapLibre 3D DEM terrain, and Telemetry Ribbon
- [ ] **Phase 4 (`v0.4.0-mvp`):** Three.js 3D vehicle kinematics and Black Box incident replay (`0.25x`)
- [ ] **Phase 5:** Coupled Canvas HUD (dual-envelope G-G diagram, `Fz` wheel load bars, KPIs)
- [ ] **Phase 6 (`v1.0.0`):** `# schema=6` exporter for `rallysim-master` and DEM vs. IMU slope cross-validation
