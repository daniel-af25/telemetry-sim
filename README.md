# telemetry-sim

2D/3D vehicle telemetry simulator built with TypeScript and Vite. The project ingests raw CSV driving logs, reconstructs vehicle dynamics in a dependency-free physics core, and prepares trip data for 2D/3D map playback, incident inspection, and offline analysis.

## Architecture

The codebase separates pure physics and data-processing logic (`src/core/`) from browser rendering (`src/ui/`) and background execution (`src/workers/`). Everything under `src/core/` runs without DOM or external math dependencies so the exact same code can execute in Node.js headless tests and browser Web Workers.

```text
src/
├── core/
│   ├── types.ts           # Shared telemetry, vehicle, load-transfer, and Kamm interfaces
│   ├── parser.ts          # CSV ingestion, # key=value metadata, milli-G scaling, spike filter
│   ├── vehicleCatalog.ts  # Vehicle database CSV parser indexed by numeric id
│   ├── loadTransfer.ts    # 4-wheel vertical load transfer and low-speed steering ramp
│   ├── kamm.ts            # Tire radius calculation and dynamic Kamm friction limits
│   └── scoring.ts         # ISO 8855 slip detection, 1.0 s debounce clustering, 300 s rule
├── data/
│   └── vehicles.csv       # Vehicle specifications catalog
├── ui/                    # MapLibre 3D DEM, Three.js vehicle layer, HUD (planned)
└── workers/               # Background CSV + kinematics pipeline (planned)

test/
├── fixtures/
│   ├── syntheticTrips.ts  # 5 Hz synthetic trip generator
│   └── vehicles_test.csv  # Vehicle catalog test fixture
├── kamm.test.ts
├── loadTransfer.test.ts
├── parser.test.ts
├── scoring.test.ts
└── vehicleCatalog.test.ts
```

## Physics Core & Conventions

### Coordinate & Sign Conventions (ISO 8855 / ENU)

- `+ax` / `-ax`: longitudinal acceleration / braking (`m/s^2`, or `g` in raw CSV before scaling)
- `+ay`: left turn (`m/s^2`); LABSIS lateral inputs are negated (`ay = -compensatedLatG * 9.80665`)
- `omegaZ`: counter-clockwise yaw rate in `rad/s` (raw sensor CSV inputs in `deg/s` are converted where applicable)

### Implemented Modules (`src/core/`)

1. **CSV Telemetry Parser (`parser.ts`)**
   - `parseCsv(csvContent)` returns `{ metadata, scalingFactor, extraChannels, data }`.
   - Extracts `# key=value` comment headers into `metadata` and supports both `,` and `;` delimiters.
   - **Auto-scaling:** scans the session for `max(|accelX|, |accelY|, |accelZ|) > 15`; when triggered, sets `scalingFactor = 1000` (milli-G to G), otherwise `1`.
   - **Spike filtering:** drops non-finite rows and physically implausible glitches (`|accel| > 25 G` post-scaling or `|gyroZ| > 2000 deg/s`).
   - **Dynamic channels:** any column outside the core telemetry set (`timestamp, lat, lon, speed, accelX, accelY, accelZ, gyroZ, gyroX, gyroY, alt`) is tracked in `extraChannels` and stored per sample in `extras`.

2. **Vehicle Catalog (`vehicleCatalog.ts`)**
   - `parseVehiclesCsv(csvContent)` parses quoted CSV rows into `Map<number, VehicleCatalogEntry>` keyed by `id`.
   - Missing or empty fields resolve to `undefined` rather than `NaN`.

3. **Quasi-Static Load Transfer (`loadTransfer.ts`)**
   - `computeLoadTransfer(ax, ay, speed, omegaZ, specs)` returns `{ fzFL, fzFR, fzRL, fzRR, steerRad, rollRad, pitchRad }`.
   - **Mass conservation:** enforces `fzFL + fzFR + fzRL + fzRR === grossMassKg * 9.80665` even under extreme longitudinal transfer or single-wheel lift (`splitAxle` clamps a lifted wheel to `0 N` and shifts the remaining axle load to the loaded wheel).
   - **Lateral distribution:** splits lateral load transfer between front and rear axles using `frontRollShare` (`trackF`, `trackR`).
   - **Low-speed damping (`w_u`):** ramps `steerRad` down linearly below `2.0 m/s` and returns `0.0` at rest (`speed <= 0`), preventing division by zero.

4. **Kamm Friction Circle (`kamm.ts`)**
   - `calculateTireRadius(tireSize)` parses commercial tire strings (e.g. `195/55 R16` -> `0.31045 m`).
   - `computeDynamicKammLimits(specs, mode)` computes `{ accelLimit, brakeLimit, latLimit, gripLimitG }` for `'road'` and `'competition'` modes, enforcing minimum road floors (`0.32 G` accel, `0.40 G` brake, `0.40 G` lateral) and `brakeLimit >= accelLimit`.

5. **Incident Scoring & Slip Detection (`scoring.ts`)**
   - `evaluateIncidentSlip(ay, speed, omegaZ)` flags slip when `ay` and `omegaZ` oppose each other (counter-steering) or when `|ay - speed * omegaZ|` exceeds the yaw-lateral divergence threshold.
   - `selectDebouncedIncident(events)` and `clusterDebouncedIncidents(events, windowS = 1.0)` group incidents separated by `dt <= 1.0 s` and pick the worst event by `points`, breaking ties with `excessRatio`.
   - `hasMinimumMovingData(movingDurationS)` enforces the `300 s` minimum moving-time threshold.

## Development

Requires **Node.js 22+** (tested on v26 with native TypeScript execution).

```bash
# Install dev dependencies (TypeScript, Vite, @types/node)
npm install

# Start Vite dev server
npm run dev

# Typecheck and build production bundle
npm run build
```

### Running Tests

Tests use Node's built-in `node:test` and `node:assert` runners:

```bash
node --test test/loadTransfer.test.ts test/kamm.test.ts test/vehicleCatalog.test.ts
```

## Roadmap

- **Phase 1 (Done):** Core types, CSV telemetry parser, vehicle catalog ingestion, load transfer, Kamm limits, and incident scoring.
- **Phase 2:** WGS84-to-ENU local projection (`wgs84ToEnu`), complementary yaw filter, tunnel dead-reckoning (`lat == 0 || lon == 0`), and 60+ FPS Hermite cubic interpolator with shortest-angle yaw interpolation.
- **Phase 3:** Web Worker pipeline, MapLibre 3D Terrarium DEM terrain centered on Portugal, 2D/3D pitch toggle, and `RdYlGn_r` Telemetry Ribbon.
- **Phase 4 (`v0.4.0-mvp`):** Three.js `CustomLayerInterface` vehicle model with terrain wheel contact, steering/wheel rotation, Chase/Top-Down/Free cameras, and `0.25x` Black Box incident jump.
- **Phase 5:** 60 FPS Canvas HUD with dual-envelope G-G diagram, per-wheel `Fz` load bars, and sanitized KPIs.
- **Phase 6 (`v1.0.0`):** `# schema=6` exporter for `rallysim-master` (`tools/topdown.py`) and Ghost Car / DEM-vs-IMU slope RMSE cross-validation.
