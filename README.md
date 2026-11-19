# telemetry-sim

2D/3D vehicle telemetry simulator built with TypeScript and Vite. The project ingests raw or v2.2 CSV driving logs, calibrates and reconstructs vehicle dynamics in a dependency-free headless physics core (`src/core/`), and prepares trip data for 2D/3D map playback, incident inspection, and offline analysis.

## Architecture

Pure physics, calibration, and data-processing modules live under `src/core/` with zero DOM or external math dependencies, so the same code runs in Vitest/Node.js headless tests and browser Web Workers.

```text
data/
└── vehicles.csv                 # Raw vehicle specifications catalog (~25k entries)

public/data/
└── vehicles.index.json          # Compact compiled index (~286 KB gzip) for Worker lazy-load

scripts/
├── buildVehicleIndex.ts         # Compiles data/vehicles.csv -> public/data/vehicles.index.json
└── runPipeline.ts               # CLI runner for quick CSV pipeline analysis (tmp/csv/)

src/core/
├── types.ts                     # Shared SI / ISO 8855 data contracts
├── csvUtils.ts                  # Shared RFC 4180 splitCsvLine & escapeCsvField
├── timestamps.ts                # Multi-format timestamp parser (ms) & gap-aware timing (> 1.0 s)
├── vehicleCatalog.ts            # Catalog CSV parser indexed by numeric id
├── vehicleSpecs.ts              # Running mass (curb + payload) & parametric geometry estimator
├── parser.ts                    # Multi-format CSV parser (labsis_v22_export & generic_iso)
├── calibration.ts               # Single LABSIS -> ISO 8855 / SI boundary (anti-ramp tare & grade)
├── kamm.ts                      # Kamm v2.2 friction circle, robust tire parsing & computeKammIndex
├── loadTransfer.ts              # 4-wheel Fz/Fx/Fy, yawMoment & Block C low-speed steering
├── scoring.ts                   # 7-category incidents, ISO slip, 5 Driving Skill Pillars & grades
└── pipeline.ts                  # End-to-end orchestrator (runTelemetryPipeline)

test/
├── fixtures/
│   ├── syntheticTrips.ts        # 5 Hz synthetic trip generator
│   └── vehicles_test.csv        # Vehicle catalog test fixture
├── integration/
│   └── pipeline.test.ts         # End-to-end & 5 Hz regression tests
├── calibration.test.ts
├── kamm.test.ts
├── loadTransfer.test.ts
├── parser.test.ts
├── scoring.test.ts
├── timestamps.test.ts
├── vehicleCatalog.test.ts
└── vehicleSpecs.test.ts
```

## Physics Core & Conventions

### Coordinate & Sign Conventions (ISO 8855 / ENU)

All modules downstream of `src/core/calibration.ts` operate strictly in SI (`m`, `m/s`, `m/s^2`, `rad`, `rad/s`, `N`) and ISO 8855:

- `+ax` / `-ax`: forward acceleration / braking (`ax = +compensatedLonG * 9.80665`)
- `+ay` / `-ay`: left / right turn (`ay = -compensatedLatG * 9.80665` from LABSIS inputs)
- `+omegaZ`: counter-clockwise (left) yaw rate in `rad/s`
- `+rollRad`: right side down (left turn `+ay`) | `+pitchRad`: nose down (braking `-ax`)

### Core Modules (`src/core/`)

1. **Timestamps (`timestamps.ts`):** `parseTimestampMs` supports epoch ms, epoch seconds, ISO-8601 (`YYYY-MM-DD HH:MM:SS.sss` / `T`), and relative seconds. `computeSampleTiming` flags temporal gaps (`rawDt > 1.0 s`) while preserving `elapsedSec`.
2. **CSV Parser (`parser.ts`):** Auto-detects `labsis_v22_export` (33-column exports with compensated G, road grade, and session/vehicle metadata) and `generic_iso`. Preserves tunnel rows (`lat`/`lon` empty or `0,0` as `null` + `gpsValid: false`), detects milli-G via `median(|accelZ|) > 100 || p95(max(|ax|,|ay|)) > 15`, filters post-scale spikes (`> 25 G` / `> 2000 deg/s`), and extracts numeric `extraChannels`.
3. **Vehicle Catalog & Specs (`vehicleCatalog.ts`, `vehicleSpecs.ts`):** Parses `data/vehicles.csv` (with `cylinders?: string` for `"V8"`, `"L4"`, etc.) and resolves `grossMassKg = curbMassKg + payloadKg` (default `75 kg`, never GVWR) plus parametric geometry (`wheelbaseL`, `trackF/R`, `cgHeight`, `frontWeightRatio`, `frontRollShare`, `maxSteerRad`).
4. **Calibration (`calibration.ts`):** Stationary tare in the first 30 s before movement (Case A), moving straight-segment median tare when a trip starts in motion (Case B, anti-ramp), `use_csv_compensated` mode with startup divergence warning, and gap-safe exponential road-grade tracking (`ALPHA_GRADE = 0.025`).
5. **Kamm v2.2 (`kamm.ts`):** Robust tire width/radius parsing (staggered `//`, `ZR`, no-`R`, hyphenated, commercial implicit 80% `C`), full v2.2 dynamic limits (`road` and `competition`), strict low-grip clamping (`<= gripLimitG`), `brakeLimit >= accelLimit`, and asymmetric `computeKammIndex`.
6. **Load Transfer & Block C Steering (`loadTransfer.ts`):** Strict mass conservation (`sum(Fz) == m * g`, error `< 1e-3 N`) with `splitAxle` wheel-lift guard, Block C steering ramp `w_u = clamp((u - 0.3) / 1.2, 0, 1)` with `max(u, 1.0)` and `±maxSteerRad` clamp, per-wheel horizontal forces (`fxFL..fxRR`, `fyFL..fyRR`), and `yawMoment`.
7. **Scoring (`scoring.ts`):** ISO 8855 slip detection (`u > 25/3.6 m/s`, `slipResidualG > 0.35 G`), 7-category incident classifier with gap-safe `1.0 s` debounce clustering, 5 Driving Skill Pillars (1:1 category mapping, zero double counting, gap-safe longitudinal jerk), overall grade (`A+`..`D`), and sufficiency rule (`>= 1500` samples AND `>= 120 s` moving).
8. **Pipeline (`pipeline.ts`):** `runTelemetryPipeline(csvText, options)` orchestrates all stages above and returns calibrated samples, load transfers, incidents, pillars, and summary KPIs.

## Development & Commands

Requires **Node.js 22+** (tested on v26) with TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess: true`).

```bash
npm install
npm run dev              # Start Vite dev server
npm run typecheck        # tsc --noEmit
npm run test             # vitest run (unit & integration suites)
npm run test:watch       # vitest watch mode
npm run test:coverage    # vitest run --coverage
npm run build:catalog    # Compile data/vehicles.csv -> public/data/vehicles.index.json
npm run check            # typecheck + test + vite build
```

### Quick CLI Trip Analysis

Drop CSV files into `tmp/csv/` and run:

```bash
node scripts/runPipeline.ts                                              # all *.csv in tmp/csv/
node scripts/runPipeline.ts session_TRIP_20261117_172131_telemetry.csv   # single file
node scripts/runPipeline.ts <file.csv> recalibrate_raw road              # custom modes
```

## Roadmap

- **Phase 1 & 1.5 (Done):** Headless physics core aligned with v2.2 (`parser`, `timestamps`, `vehicleCatalog`, `vehicleSpecs`, `calibration`, `kamm`, `loadTransfer`, `scoring`, `pipeline`), compact vehicle index builder, Vitest suite, and CLI runner.
- **Phase 2:** WGS84-to-ENU local projection (`wgs84ToEnu`), complementary yaw filter, tunnel dead-reckoning (`!gpsValid`), and 60+ FPS Hermite cubic interpolator with shortest-angle yaw interpolation.
- **Phase 3:** Web Worker pipeline, MapLibre 3D Terrarium DEM terrain centered on Portugal, 2D/3D pitch toggle, and `RdYlGn_r` Telemetry Ribbon.
- **Phase 4 (`v0.4.0-mvp`):** Three.js `CustomLayerInterface` vehicle model with terrain wheel contact, steering/wheel rotation, Chase/Top-Down/Free cameras, and `0.25x` Black Box incident jump.
- **Phase 5:** 60 FPS Canvas HUD with dual-envelope G-G diagram, per-wheel `Fz` load bars, and sanitized KPIs.
- **Phase 6 (`v1.0.0`):** `# schema=6` exporter for `rallysim-master` (`view3d.py` / `topdown.py`) and Ghost Car / DEM-vs-IMU slope RMSE cross-validation.
