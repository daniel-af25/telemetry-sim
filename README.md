# telemetry-sim

2D/3D vehicle telemetry simulator built with TypeScript, Vite, and MapLibre GL. It ingests raw or LABSIS v2.2 CSV driving logs, reconstructs vehicle dynamics and ENU kinematics in a dependency-free headless physics core inside a Web Worker, and renders interactive 2D/3D map playback, `RdYlGn_r` telemetry ribbons, and WebM video exports in the browser.

## Architecture

Pure physics, calibration, kinematics, and zero-copy SoA packing live under `src/core/` with zero DOM or external math dependencies, so the exact same code runs in Vitest/Node.js headless tests and browser Web Workers.

```text
data/
└── vehicles.csv                 # Raw vehicle specifications catalog (~25k entries)

public/data/
└── vehicles.index.json          # Compact compiled index (~286 KB gzip) for Worker lazy-load

scripts/
├── buildVehicleIndex.ts         # Compiles data/vehicles.csv -> public/data/vehicles.index.json
└── runPipeline.ts               # CLI runner for quick CSV pipeline analysis (tmp/csv/)

src/
├── core/
│   ├── types.ts                 # Shared SI / ISO 8855 data contracts
│   ├── csvUtils.ts              # Shared RFC 4180 splitCsvLine & escapeCsvField
│   ├── timestamps.ts            # Multi-format timestamp parser (ms) & gap-aware timing (> 1.0 s)
│   ├── vehicleCatalog.ts        # Catalog CSV parser indexed by numeric id
│   ├── vehicleSpecs.ts          # Running mass (curb + payload) & parametric geometry estimator
│   ├── parser.ts                # Multi-format CSV parser (labsis_v22_export & generic_iso)
│   ├── calibration.ts           # Single LABSIS -> ISO 8855 / SI boundary (anti-ramp tare & grade)
│   ├── kamm.ts                  # Kamm v2.2 friction circle, robust tire parsing & computeKammIndex
│   ├── loadTransfer.ts          # 4-wheel Fz/Fx/Fy, yawMoment & Block C low-speed steering
│   ├── scoring.ts               # 7-category incidents, ISO slip, 5 Driving Skill Pillars & grades
│   ├── pipeline.ts              # End-to-end headless orchestrator (runTelemetryPipeline)
│   ├── kinematics.ts            # WGS84 <-> ENU projection, complementary yaw & tunnel loop-closure
│   ├── soa.ts                   # Zero-copy TelemetryTrackSoA TypedArrays & getTransferables()
│   └── interpolator.ts          # 60+ FPS Fritsch-Carlson Hermite & shortest-angle interpolator
├── workers/
│   ├── protocol.ts              # Typed WorkerRequest / WorkerResponse discriminated unions
│   └── telemetry.worker.ts      # Lazy 25k catalog search (< 5 ms) & zero-copy CSV processing
├── state/
│   ├── appStore.ts              # Lightweight typed pub/sub store for cold UI/session state
│   └── playbackClock.ts         # Single master 60 FPS requestAnimationFrame clock (0.25x..4x)
├── ui/
│   ├── sanitize.ts              # XSS-safe escapeHtml() for CSV/catalog metadata
│   ├── mapView.ts               # MapLibre GL 2D/3D, 3 free basemaps, Terrarium DEM, 3D buildings & Ribbon
│   ├── videoRecorder.ts         # Native 30 FPS WebM video recorder with telemetry HUD watermark
│   └── controlsBar.ts           # Top HUD bar, collapsible What-If panel, 25k autocomplete & timeline
├── main.ts                      # Application bootstrap wiring Worker, Store, Clock, Map & Controls
└── style.css                    # Dark Motorsport Telemetry glassmorphic UI theme

test/
├── fixtures/
│   ├── syntheticTrips.ts        # 5 Hz synthetic trip generator
│   └── vehicles_test.csv        # Vehicle catalog test fixture
├── integration/
│   └── pipeline.test.ts         # End-to-end & 5 Hz regression tests
├── ui/
│   ├── appStore.test.ts
│   ├── mapView.test.ts
│   ├── playbackClock.test.ts
│   ├── sanitize.test.ts
│   └── videoRecorder.test.ts
├── calibration.test.ts
├── interpolator.test.ts
├── kamm.test.ts
├── kinematics.test.ts
├── loadTransfer.test.ts
├── parser.test.ts
├── scoring.test.ts
├── soa.test.ts
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
- Local ENU: `+x = East`, `+y = North`, `yawRad` CCW from `+East`

### Implemented Capabilities

- **Phase 1 & 1.5 (Physics Core v2.2):** Multi-format CSV parser (`labsis_v22_export` 33-col & `generic_iso`), gap-aware timestamps (`> 1.0 s`), vehicle catalog (`data/vehicles.csv` → `public/data/vehicles.index.json`), running mass (`curbMassKg + payloadKg`, never GVWR) & parametric geometry, anti-ramp MPU6050 calibration with road-grade tracking, Kamm v2.2 friction circle with low-grip clamping, 4-wheel load transfer (`sum(Fz) == m * g`) with Block C steering, 7-category incident engine, and 5 Driving Skill Pillars.
- **Phase 2 (Kinematics, SoA & 60+ FPS Interpolator):** Ellipsoidal WGS84 ↔ ENU projection (`R_M`, `R_N`), complementary yaw filter, C0 loop-closed tunnel dead-reckoning (`isTunnelDr`), contiguous `TelemetryTrackSoA` zero-copy transferables, and Fritsch-Carlson monotone cubic Hermite + shortest-angle interpolation with `O(1)` sequential cursor and zero-allocation `sampleAt(t, out)`.
- **Phase 3 (Web Worker, MapLibre 3D DEM, Ribbon & Video Export):**
  - **Web Worker:** Lazy-loads `/data/vehicles.index.json` with `< 5 ms` token search across 25,374 vehicles, processes CSVs off the main thread with cooperative `CANCEL` and `PROGRESS` events, and transfers `TelemetryTrackSoA` zero-copy.
  - **Interactive 2D/3D Map (`mapView.ts`):** 3 free zero-API-key basemaps (**Dark 3D** CARTO Dark Matter, **Satellite 3D** Esri World Imagery, **Vector 3D** OpenFreeMap Liberty) + resilient offline dark fallback, AWS Terrarium 3D DEM terrain + dedicated hillshade, OpenFreeMap 3D extruded buildings, sky/light atmosphere, quantized 24-bin `RdYlGn_r` Telemetry Ribbon, dashed cyan tunnel layer (`IS_TUNNEL_DR`), and 60 FPS directional vehicle marker.
  - **Live Controls & Video Export (`controlsBar.ts`, `videoRecorder.ts`):** Drag-and-drop CSV upload, live What-If controls (`road`/`competition`, `surfaceGrip` + Dry/Wet/Ice presets, `payloadKg`), 60 FPS timeline dock (`Space` play/pause, `0.25x..4x`), and native 30 FPS WebM video recording with an embedded telemetry HUD watermark.

## Development & Commands

Requires **Node.js 22+** (tested on v26) with TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess: true`).

```bash
npm install
npm run dev              # Start Vite dev server (http://localhost:5173)
npm run typecheck        # tsc --noEmit
npm run test             # vitest run (17 suites / 77 tests)
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

- **Phase 1 & 1.5 (Done):** Headless physics core aligned with v2.2, compact vehicle index builder, Vitest suite, and CLI runner.
- **Phase 2 (Done):** WGS84-to-ENU projection, complementary yaw filter, C0 tunnel dead-reckoning, zero-copy SoA, and 60+ FPS Hermite interpolator.
- **Phase 3 (Done):** Web Worker pipeline, `AppStore`, `PlaybackClock`, MapLibre 3D DEM + 3D buildings + 3 free basemaps, `RdYlGn_r` Telemetry Ribbon, What-If controls, and WebM video recorder.
- **Phase 4 (`v0.4.0-mvp`):** Three.js `CustomLayerInterface` 3D vehicle model with terrain wheel contact, steering/wheel rotation, suspension exaggeration, and `0.25x` Black Box incident jump.
- **Phase 5:** 60 FPS Canvas HUD with dual-envelope G-G diagram, per-wheel `Fz` load bars, and sanitized KPIs.
- **Phase 6 (`v1.0.0`):** `# schema=6` exporter for `rallysim-master` (`view3d.py` / `topdown.py`) and Ghost Car / DEM-vs-IMU slope RMSE cross-validation.
