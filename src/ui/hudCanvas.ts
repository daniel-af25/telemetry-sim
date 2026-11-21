/**
 * Painel HUD de Telemetria a 60+ FPS em Canvas HiDPI (`src/ui/hudCanvas.ts`):
 * 1. Diagrama G-G Duplo Assimétrico (elipse interior tracejada `accelLimit`/`brakeLimit`/`±latLimit`,
 *    círculo exterior físico `gripLimitG`, rasto dos últimos 2.0 s, clamp visual à borda,
 *    convenção ISO 8855: `+ax` cima, `-ax` baixo, `+ay` esquerda).
 * 2. Widget Fz (4 rodas FL/FR/RL/RR em kN, % utilização de atrito na rampa `RdYlGn_r`,
 *    aviso visual de levantamento de roda `Fz == 0`).
 * 3. Cartão dos 5 Pilares & KPIs instantâneos (`km/h`, `kammIndex`, `roadGradePct`, `steerDeg`, `roll`/`pitch`),
 *    com regra `INSUFFICIENT DATA` (< 1500 amostras ou < 120 s em movimento).
 * 4. Sparkline em tempo real de canais extras (`extraChannels`) + canais internos de fallback.
 * 5. Proteção rigorosa contra XSS: todos os textos de CSV renderizados via `textContent` / `escapeHtml()`.
 *
 * Testes:
 *   npx vitest run test/ui/sanitize.test.ts test/ui/hudCanvas.test.ts
 */
import type { SampleFrame } from '../core/interpolator.ts';
import type { DynamicKammLimitsResult } from '../core/kamm.ts';
import type { TelemetryPipelineSummary } from '../core/pipeline.ts';
import type { DrivingSkillPillar } from '../core/scoring.ts';
import { TRACK_FLAG, type TelemetryTrackSoA } from '../core/soa.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';
import { RDYLGN_R_PALETTE } from './mapView.ts';
import { escapeHtml } from './sanitize.ts';

const GRAVITY_MS2 = 9.80665;
const RAD_TO_DEG = 180 / Math.PI;
const GG_TRAIL_WINDOW_SEC = 2.0;
const SPARKLINE_WINDOW_SEC = 30.0;
const WHEEL_LIFT_THRESHOLD_N = 0.5;

const GG_CSS_SIZE = 178;
const FZ_CSS_W = 160;
const FZ_CSS_H = 178;
const SPARK_CSS_W = 200;
const SPARK_CSS_H = 112;

export interface ClampedPoint2D {
  x: number;
  y: number;
  clamped: boolean;
}

/**
 * Clamps a `(xG, yG)` point to a circle of radius `maxRadiusG` so extreme peaks
 * remain visibly anchored to the outer rim of the G-G plot instead of disappearing.
 */
export function clampPointToCircle(
  xG: number,
  yG: number,
  maxRadiusG: number,
): ClampedPoint2D {
  const safeX = Number.isFinite(xG) ? xG : 0;
  const safeY = Number.isFinite(yG) ? yG : 0;
  const safeMax = Math.max(0.1, Number.isFinite(maxRadiusG) ? maxRadiusG : 1.2);
  const r = Math.hypot(safeX, safeY);
  if (r <= safeMax || r <= 1e-9) {
    return { x: safeX, y: safeY, clamped: false };
  }
  const scale = safeMax / r;
  return { x: safeX * scale, y: safeY * scale, clamped: true };
}

/**
 * Computes per-wheel friction utilization ratio (`0..1.5+`) and wheel-lift state (`Fz <= 0.5 N`).
 */
export function computeWheelFrictionUtilization(
  fzN: number,
  axMs2: number,
  ayMs2: number,
  gripLimitG: number,
): { ratio: number; isLifted: boolean } {
  const safeFz = Number.isFinite(fzN) ? Math.max(0, fzN) : 0;
  if (safeFz <= WHEEL_LIFT_THRESHOLD_N) {
    return { ratio: 0, isLifted: true };
  }
  const netG = Math.hypot(
    Number.isFinite(axMs2) ? axMs2 / GRAVITY_MS2 : 0,
    Number.isFinite(ayMs2) ? ayMs2 / GRAVITY_MS2 : 0,
  );
  const safeGrip = Math.max(0.15, Number.isFinite(gripLimitG) ? gripLimitG : 0.95);
  return { ratio: netG / safeGrip, isLifted: false };
}

/**
 * Formats external CSV metadata (`# key=value`, driver, vehicle, session_id) into a
 * strictly HTML-escaped summary string safe against XSS injection.
 */
export function formatSanitizedSessionMetadata(input: {
  sessionId?: string | null;
  driverName?: string | null;
  vehicleName?: string | null;
  metadata?: Record<string, string>;
}): string {
  const parts: string[] = [];
  if (input.sessionId) parts.push(escapeHtml(input.sessionId));
  if (input.driverName) parts.push(escapeHtml(input.driverName));
  if (input.vehicleName) parts.push(escapeHtml(input.vehicleName));
  if (input.metadata) {
    let extrasShown = 0;
    for (const [k, v] of Object.entries(input.metadata)) {
      if (!k || !v) continue;
      if (extrasShown >= 2) break;
      parts.push(`${escapeHtml(k)}=${escapeHtml(v)}`);
      extrasShown += 1;
    }
  }
  return parts.join(' · ');
}

function colorForRdYlGnR(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const idx = Math.min(
    RDYLGN_R_PALETTE.length - 1,
    Math.floor(clamped * (RDYLGN_R_PALETTE.length - 1) + 1e-9),
  );
  return RDYLGN_R_PALETTE[idx] ?? '#10b981';
}

function setupHiDpiCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  cache: { w: number; h: number; dpr: number },
): CanvasRenderingContext2D | null {
  const dpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? Math.min(2.5, Math.max(1, window.devicePixelRatio))
      : 1;

  if (cache.w !== cssW || cache.h !== cssH || cache.dpr !== dpr) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    cache.w = cssW;
    cache.h = cssH;
    cache.dpr = dpr;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type BuiltinSparkChannel = 'builtin:speed' | 'builtin:kamm' | 'builtin:grade' | 'builtin:steer';

const BUILTIN_SPARK_OPTIONS: ReadonlyArray<{
  value: BuiltinSparkChannel;
  label: string;
  unit: string;
}> = [
  { value: 'builtin:speed', label: 'Velocidade', unit: 'km/h' },
  { value: 'builtin:kamm', label: 'Kamm Index', unit: '×' },
  { value: 'builtin:grade', label: 'Declive', unit: '%' },
  { value: 'builtin:steer', label: 'Direção', unit: '°' },
];

export interface HudSessionData {
  sessionId?: string | null;
  driverName?: string | null;
  vehicleName?: string | null;
  metadata?: Record<string, string>;
  vehicleSpecs: ResolvedVehicleSpecs;
  kammLimits: DynamicKammLimitsResult;
  pillars: readonly DrivingSkillPillar[];
  summary: TelemetryPipelineSummary;
  track: TelemetryTrackSoA;
  extraChannels?: readonly string[];
  extraChannelSeries?: Readonly<Record<string, Float32Array>>;
}

export interface HudCanvasOptions {
  container: HTMLElement;
  initialCollapsed?: boolean;
}

export interface HudCanvasController {
  setSessionData(data: HudSessionData): void;
  updateFrame(tSec: number, frame: SampleFrame | null): void;
  setCollapsed(collapsed: boolean): void;
  isCollapsed(): boolean;
  dispose(): void;
}

/**
 * Builds and manages the 60+ FPS HiDPI Canvas Telemetry HUD coupled to `PlaybackClock`:
 * Dual Asymmetric G-G Diagram, 4-wheel Fz bars with wheel-lift alert, 5 Driving Skill Pillars,
 * instantaneous KPIs, and dynamic extra-channel Sparklines — 100% XSS-safe.
 */
export function createHudCanvas(options: HudCanvasOptions): HudCanvasController {
  const { container } = options;
  let collapsed = options.initialCollapsed ?? true;
  let session: HudSessionData | null = null;
  let lastTimeSec = 0;
  let lastFrame: SampleFrame | null = null;
  let selectedChannel: string = 'builtin:kamm';

  const ggCache = { w: 0, h: 0, dpr: 0 };
  const fzCache = { w: 0, h: 0, dpr: 0 };
  const sparkCache = { w: 0, h: 0, dpr: 0 };

  // -------------------------------------------------------------------------
  // DOM Layout (Dark Motorsport Glassmorphism, 100% textContent / sanitized)
  // -------------------------------------------------------------------------
  const shell = el('div', `hud-shell${collapsed ? ' is-collapsed' : ''}`);

  const toggleBtn = el('button', 'hud-toggle glass-panel');
  toggleBtn.type = 'button';
  toggleBtn.title = 'Expandir / recolher HUD de Telemetria (G-G, Fz, 5 Pilares, Sparkline)';
  toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  const toggleIcon = el('span', 'hud-toggle__icon', collapsed ? '▲' : '▼');
  const toggleText = el('span', 'hud-toggle__text', 'TELEMETRY HUD · G-G · Fz · 5 PILARES');
  toggleBtn.append(toggleIcon, toggleText);

  const deck = el('section', 'hud-deck glass-panel');
  deck.setAttribute('aria-label', 'HUD de Telemetria em Tempo Real');

  // Column 1: Dual Asymmetric G-G Diagram (Canvas HiDPI)
  const ggCol = el('div', 'hud-col hud-col--gg');
  const ggHeader = el('div', 'hud-col__header');
  ggHeader.append(el('span', 'hud-col__title', 'DIAGRAMA G-G'));
  const ggReadout = el('span', 'hud-col__meta tabular-nums', '0.00 G');
  ggHeader.append(ggReadout);
  const ggCanvas = document.createElement('canvas');
  ggCanvas.className = 'hud-canvas';
  ggCol.append(ggHeader, ggCanvas);

  // Column 2: 4-Wheel Fz Widget (Canvas HiDPI)
  const fzCol = el('div', 'hud-col hud-col--fz');
  const fzHeader = el('div', 'hud-col__header');
  fzHeader.append(el('span', 'hud-col__title', 'CARGA Fz (4 RODAS)'));
  const fzTotalReadout = el('span', 'hud-col__meta tabular-nums', '— kN');
  fzHeader.append(fzTotalReadout);
  const fzCanvas = document.createElement('canvas');
  fzCanvas.className = 'hud-canvas';
  fzCol.append(fzHeader, fzCanvas);

  // Column 3: 5 Pillars & Live KPIs Card
  const pillarsCol = el('div', 'hud-col hud-col--pillars');
  const pillarsHeader = el('div', 'hud-col__header');
  pillarsHeader.append(el('span', 'hud-col__title', '5 PILARES & KPIs'));
  const globalScoreBadge = el('span', 'hud-score-badge tabular-nums', '—');
  pillarsHeader.append(globalScoreBadge);

  const metaLine = el('div', 'hud-meta-line', 'Sem sessão carregada');
  const pillarsList = el('div', 'hud-pillars-list');

  const kpiGrid = el('div', 'hud-kpi-grid');
  const kpiSpeed = createHudKpi('VEL', '0.0', 'km/h');
  const kpiKamm = createHudKpi('KAMM', '0.00', '×');
  const kpiGrade = createHudKpi('DECLIVE', '+0.0', '%');
  const kpiSteer = createHudKpi('STEER', '+0.0', '°');
  const kpiAttitude = createHudKpi('ROLL / PITCH', '+0.0° / +0.0°', '');
  kpiGrid.append(
    kpiSpeed.root,
    kpiKamm.root,
    kpiGrade.root,
    kpiSteer.root,
    kpiAttitude.root,
  );

  pillarsCol.append(pillarsHeader, metaLine, pillarsList, kpiGrid);

  // Column 4: Extra Channels Sparkline (Canvas HiDPI + Dynamic Selector)
  const sparkCol = el('div', 'hud-col hud-col--spark');
  const sparkHeader = el('div', 'hud-col__header');
  sparkHeader.append(el('span', 'hud-col__title', 'CANAIS EXTRAS'));
  const sparkValReadout = el('span', 'hud-col__meta tabular-nums', '—');
  sparkHeader.append(sparkValReadout);

  const sparkSelect = el('select', 'telemetry-select hud-spark-select');
  sparkSelect.setAttribute('aria-label', 'Selecionar canal extra para sparkline');
  sparkSelect.addEventListener('change', () => {
    selectedChannel = sparkSelect.value;
    drawSparkline(lastTimeSec);
  });

  const sparkCanvas = document.createElement('canvas');
  sparkCanvas.className = 'hud-canvas';
  const sparkBoundsRow = el('div', 'hud-spark-bounds tabular-nums');
  const sparkMinEl = el('span', undefined, 'min —');
  const sparkMaxEl = el('span', undefined, 'max —');
  sparkBoundsRow.append(sparkMinEl, sparkMaxEl);

  sparkCol.append(sparkHeader, sparkSelect, sparkCanvas, sparkBoundsRow);

  deck.append(ggCol, fzCol, pillarsCol, sparkCol);
  shell.append(toggleBtn, deck);
  container.append(shell);

  function setCollapsed(nextCollapsed: boolean): void {
    collapsed = nextCollapsed;
    shell.classList.toggle('is-collapsed', collapsed);
    toggleIcon.textContent = collapsed ? '▲' : '▼';
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) {
      redrawAllCanvases(lastTimeSec, lastFrame);
    }
  }

  toggleBtn.addEventListener('click', () => {
    setCollapsed(!collapsed);
  });

  // -------------------------------------------------------------------------
  // Binary search helper for track time lookup (O(log n))
  // -------------------------------------------------------------------------
  function findIndexAtOrBefore(tArr: Float64Array, targetSec: number): number {
    const n = tArr.length;
    if (n === 0) return -1;
    if (targetSec <= (tArr[0] ?? 0)) return 0;
    if (targetSec >= (tArr[n - 1] ?? 0)) return n - 1;

    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const tMid = tArr[mid] ?? 0;
      if (tMid <= targetSec) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return Math.max(0, hi);
  }

  // -------------------------------------------------------------------------
  // 1. Dual Asymmetric G-G Diagram (HiDPI Canvas)
  // -------------------------------------------------------------------------
  function drawGGDiagram(tSec: number, frame: SampleFrame | null): void {
    const ctx = setupHiDpiCanvas(ggCanvas, GG_CSS_SIZE, GG_CSS_SIZE, ggCache);
    if (!ctx) return;

    const w = GG_CSS_SIZE;
    const h = GG_CSS_SIZE;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const plotR = w * 0.41;

    ctx.clearRect(0, 0, w, h);

    const limits = session?.kammLimits ?? {
      accelLimit: 0.45,
      brakeLimit: 0.55,
      latLimit: 0.50,
      gripLimitG: 0.95,
    };

    const maxScaleG = Math.max(
      1.1,
      limits.gripLimitG * 1.15,
      limits.brakeLimit * 1.25,
      limits.latLimit * 1.25,
    );
    const pxPerG = plotR / maxScaleG;

    // Background disc
    ctx.beginPath();
    ctx.arc(cx, cy, plotR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(7, 12, 24, 0.85)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.stroke();

    // Subtle 0.5G grid ring & crosshairs
    if (0.5 < maxScaleG) {
      ctx.beginPath();
      ctx.arc(cx, cy, 0.5 * pxPerG, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(cx - plotR, cy);
    ctx.lineTo(cx + plotR, cy);
    ctx.moveTo(cx, cy - plotR);
    ctx.lineTo(cx, cy + plotR);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.stroke();

    // Outer circle: Physical Grip Limit (radius = gripLimitG)
    const gripR = Math.min(plotR, limits.gripLimitG * pxPerG);
    ctx.beginPath();
    ctx.arc(cx, cy, gripR, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.stroke();

    // Inner dashed ellipse: Asymmetric Safety Envelope
    // Upper half (+ax = accelLimit), lower half (-ax = brakeLimit), width = ±latLimit
    const latPx = Math.min(plotR, limits.latLimit * pxPerG);
    const accPx = Math.min(plotR, limits.accelLimit * pxPerG);
    const brkPx = Math.min(plotR, limits.brakeLimit * pxPerG);

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fbbf24';
    ctx.beginPath();
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      // ISO 8855: +ay is LEFT (-x_canvas), +ax is UP (-y_canvas)
      const px = cx - latPx * cosT;
      const py = sinT >= 0 ? cy - accPx * sinT : cy - brkPx * sinT;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Axis labels (ISO 8855 visual convention: +ax UP, -ax DOWN, +ay LEFT, -ay RIGHT)
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 8.5px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ACC +', cx, 8);
    ctx.fillText('BRK -', cx, h - 8);
    ctx.fillText('L', 8, cy);
    ctx.fillText('R', w - 8, cy);

    // Physical grip label
    ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
    ctx.font = '600 8px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`μ ${limits.gripLimitG.toFixed(2)}G`, w - 4, 12);

    // 2.0 s temporal trail from track SoA (stopping at IS_GAP boundaries)
    if (session && session.track.length > 0) {
      const track = session.track;
      const endIdx = findIndexAtOrBefore(track.t, tSec);
      const minTime = tSec - GG_TRAIL_WINDOW_SEC;
      let startIdx = endIdx;
      while (startIdx > 0 && (track.t[startIdx - 1] ?? 0) >= minTime) {
        if (((track.flags[startIdx] ?? 0) & TRACK_FLAG.IS_GAP) !== 0) {
          break;
        }
        startIdx -= 1;
      }

      const spanCount = endIdx - startIdx;
      if (spanCount >= 1) {
        for (let i = startIdx; i < endIdx; i++) {
          if (((track.flags[i + 1] ?? 0) & TRACK_FLAG.IS_GAP) !== 0) continue;

          const ay0 = (track.ay[i] ?? 0) / GRAVITY_MS2;
          const ax0 = (track.ax[i] ?? 0) / GRAVITY_MS2;
          const ay1 = (track.ay[i + 1] ?? 0) / GRAVITY_MS2;
          const ax1 = (track.ax[i + 1] ?? 0) / GRAVITY_MS2;

          const p0 = clampPointToCircle(-ay0, -ax0, maxScaleG);
          const p1 = clampPointToCircle(-ay1, -ax1, maxScaleG);

          const ageFrac = (i - startIdx + 1) / Math.max(1, spanCount);
          const kamm = track.kammIndex[i + 1] ?? 0;

          ctx.beginPath();
          ctx.moveTo(cx + p0.x * pxPerG, cy + p0.y * pxPerG);
          ctx.lineTo(cx + p1.x * pxPerG, cy + p1.y * pxPerG);
          ctx.lineWidth = 1.4 + ageFrac * 1.6;
          ctx.globalAlpha = 0.12 + ageFrac * 0.78;
          ctx.strokeStyle = colorForRdYlGnR(kamm / 1.15);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    // Current G point + visual clamp halo when exceeding full scale
    if (frame) {
      const axG = Number.isFinite(frame.ax) ? frame.ax / GRAVITY_MS2 : 0;
      const ayG = Number.isFinite(frame.ay) ? frame.ay / GRAVITY_MS2 : 0;
      const netG = Math.hypot(axG, ayG);
      ggReadout.textContent = `${netG.toFixed(2)} G`;

      // Canvas coords: +ay (left) -> negative X, +ax (accel) -> negative Y
      const clamped = clampPointToCircle(-ayG, -axG, maxScaleG);
      const px = cx + clamped.x * pxPerG;
      const py = cy + clamped.y * pxPerG;
      const dotColor = colorForRdYlGnR(frame.kammIndex / 1.15);

      // Vector line from origin to current G point
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(px, py);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = dotColor;
      ctx.stroke();

      if (clamped.clamped) {
        ctx.beginPath();
        ctx.arc(px, py, 8.5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#f43f5e';
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#f8fafc';
      ctx.stroke();
    } else {
      ggReadout.textContent = '0.00 G';
    }
  }

  // -------------------------------------------------------------------------
  // 2. 4-Wheel Fz Widget (HiDPI Canvas)
  // -------------------------------------------------------------------------
  function drawFzBars(frame: SampleFrame | null): void {
    const ctx = setupHiDpiCanvas(fzCanvas, FZ_CSS_W, FZ_CSS_H, fzCache);
    if (!ctx) return;

    const w = FZ_CSS_W;
    const h = FZ_CSS_H;
    ctx.clearRect(0, 0, w, h);

    const grossMass = session?.vehicleSpecs.grossMassKg ?? 1500;
    const gripLimitG = session?.kammLimits.gripLimitG ?? 0.95;
    const totalWeightN = grossMass * GRAVITY_MS2;
    const maxBarN = Math.max(1000, totalWeightN * 0.55);

    const wheels: ReadonlyArray<{ id: string; fzN: number }> = [
      { id: 'FL', fzN: frame ? frame.fzFL : totalWeightN * 0.29 },
      { id: 'FR', fzN: frame ? frame.fzFR : totalWeightN * 0.29 },
      { id: 'RL', fzN: frame ? frame.fzRL : totalWeightN * 0.21 },
      { id: 'RR', fzN: frame ? frame.fzRR : totalWeightN * 0.21 },
    ];

    const sumKn = (wheels[0]!.fzN + wheels[1]!.fzN + wheels[2]!.fzN + wheels[3]!.fzN) / 1000;
    fzTotalReadout.textContent = `${sumKn.toFixed(1)} kN`;

    const padX = 10;
    const topY = 24;
    const bottomY = h - 34;
    const barAreaH = bottomY - topY;
    const colW = (w - padX * 2) / 4;
    const barW = Math.min(22, colW - 10);

    // Subtle baseline & 50% guide line
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, bottomY);
    ctx.lineTo(w - padX, bottomY);
    ctx.moveTo(padX, topY + barAreaH * 0.5);
    ctx.lineTo(w - padX, topY + barAreaH * 0.5);
    ctx.stroke();

    const ax = frame ? frame.ax : 0;
    const ay = frame ? frame.ay : 0;

    for (let i = 0; i < 4; i++) {
      const wheel = wheels[i]!;
      const cx = padX + colW * (i + 0.5);
      const x0 = cx - barW * 0.5;
      const safeFz = Math.max(0, Number.isFinite(wheel.fzN) ? wheel.fzN : 0);
      const fzKn = safeFz / 1000;

      const { ratio, isLifted } = computeWheelFrictionUtilization(safeFz, ax, ay, gripLimitG);
      const utilPct = Math.round(Math.min(199, ratio * 100));
      const fillFrac = Math.max(0, Math.min(1, safeFz / maxBarN));
      const barH = fillFrac * barAreaH;
      const barColor = isLifted ? '#f43f5e' : colorForRdYlGnR(ratio);

      // Bar track background
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeStyle = isLifted ? '#f43f5e' : 'rgba(148, 163, 184, 0.2)';
      ctx.lineWidth = isLifted ? 1.8 : 1;
      ctx.fillRect(x0, topY, barW, barAreaH);
      ctx.strokeRect(x0, topY, barW, barAreaH);

      // Dynamic Fz fill bar
      if (!isLifted && barH > 0.5) {
        ctx.fillStyle = barColor;
        ctx.fillRect(x0 + 1, bottomY - barH, barW - 2, barH);
      }

      // Top readout: kN (or LIFT! warning when Fz == 0)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      if (isLifted) {
        ctx.fillStyle = '#f43f5e';
        ctx.font = '800 8.5px ui-monospace, SFMono-Regular, monospace';
        ctx.fillText('LIFT!', cx, topY - 4);
      } else {
        ctx.fillStyle = '#f1f5f9';
        ctx.font = '700 9px ui-monospace, SFMono-Regular, monospace';
        ctx.fillText(`${fzKn.toFixed(1)}`, cx, topY - 4);
      }

      // Wheel label (FL, FR, RL, RR)
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '800 9.5px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(wheel.id, cx, bottomY + 5);

      // Friction utilization % colored by RdYlGn_r
      ctx.fillStyle = isLifted ? '#fda4af' : barColor;
      ctx.font = '700 8.5px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(isLifted ? '0%' : `${utilPct}%`, cx, bottomY + 18);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Extra Channels Sparkline (HiDPI Canvas)
  // -------------------------------------------------------------------------
  function getSparklineSeries(
    channelKey: string,
  ): { values: Float32Array; unit: string } | null {
    if (!session) return null;
    const track = session.track;

    if (channelKey.startsWith('extra:')) {
      const colName = channelKey.slice('extra:'.length);
      const series = session.extraChannelSeries?.[colName];
      return series ? { values: series, unit: '' } : null;
    }

    switch (channelKey) {
      case 'builtin:speed': {
        const out = new Float32Array(track.length);
        for (let i = 0; i < track.length; i++) out[i] = (track.speedMs[i] ?? 0) * 3.6;
        return { values: out, unit: ' km/h' };
      }
      case 'builtin:grade':
        return { values: track.roadGradePct, unit: '%' };
      case 'builtin:steer': {
        const out = new Float32Array(track.length);
        for (let i = 0; i < track.length; i++) out[i] = (track.steerRad[i] ?? 0) * RAD_TO_DEG;
        return { values: out, unit: '°' };
      }
      case 'builtin:kamm':
      default:
        return { values: track.kammIndex, unit: '×' };
    }
  }

  let cachedSparkKey = '';
  let cachedSparkData: { values: Float32Array; unit: string } | null = null;

  function drawSparkline(tSec: number): void {
    const ctx = setupHiDpiCanvas(sparkCanvas, SPARK_CSS_W, SPARK_CSS_H, sparkCache);
    if (!ctx) return;

    const w = SPARK_CSS_W;
    const h = SPARK_CSS_H;
    ctx.clearRect(0, 0, w, h);

    // Background box
    ctx.fillStyle = 'rgba(7, 12, 24, 0.85)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.lineWidth = 1;
    ctx.fillRect(0.5, 0.5, w - 1, h - 1);
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    if (!session || session.track.length === 0) {
      sparkValReadout.textContent = '—';
      sparkMinEl.textContent = 'min —';
      sparkMaxEl.textContent = 'max —';
      return;
    }

    if (cachedSparkKey !== selectedChannel) {
      cachedSparkKey = selectedChannel;
      cachedSparkData = getSparklineSeries(selectedChannel);
    }

    const data = cachedSparkData;
    if (!data || data.values.length === 0) {
      sparkValReadout.textContent = 'N/A';
      return;
    }

    const tArr = session.track.t;
    const flags = session.track.flags;
    const vals = data.values;
    const n = Math.min(tArr.length, vals.length);

    const curIdx = Math.min(n - 1, Math.max(0, findIndexAtOrBefore(tArr, tSec)));
    const halfWin = SPARKLINE_WINDOW_SEC * 0.5;
    const tStart = Math.max(tArr[0] ?? 0, tSec - halfWin);
    const tEnd = Math.max(tStart + 1, tStart + SPARKLINE_WINDOW_SEC);

    const iStart = findIndexAtOrBefore(tArr, tStart);
    const iEnd = Math.min(n - 1, findIndexAtOrBefore(tArr, tEnd) + 1);

    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = iStart; i <= iEnd; i++) {
      const v = vals[i] ?? Number.NaN;
      if (Number.isFinite(v)) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }

    if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
      sparkValReadout.textContent = '—';
      sparkMinEl.textContent = 'min —';
      sparkMaxEl.textContent = 'max —';
      return;
    }

    const spanV = maxV - minV < 1e-4 ? 1 : maxV - minV;
    const padX = 6;
    const padY = 10;
    const plotW = w - padX * 2;
    const plotH = h - padY * 2;

    // Horizontal mid-line
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.beginPath();
    ctx.moveTo(padX, padY + plotH * 0.5);
    ctx.lineTo(w - padX, padY + plotH * 0.5);
    ctx.stroke();

    // Sparkline trace (splitting across IS_GAP / NaN)
    ctx.beginPath();
    let penDown = false;
    for (let i = iStart; i <= iEnd; i++) {
      const v = vals[i] ?? Number.NaN;
      const isGap = i > iStart && ((flags[i] ?? 0) & TRACK_FLAG.IS_GAP) !== 0;
      if (!Number.isFinite(v) || isGap) {
        penDown = false;
        continue;
      }
      const x = padX + (((tArr[i] ?? tStart) - tStart) / (tEnd - tStart)) * plotW;
      const y = padY + (1 - (v - minV) / spanV) * plotH;
      if (!penDown) {
        ctx.moveTo(x, y);
        penDown = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#38bdf8';
    ctx.stroke();

    // Playhead vertical cursor + current dot
    const curX = padX + Math.max(0, Math.min(1, (tSec - tStart) / (tEnd - tStart))) * plotW;
    ctx.beginPath();
    ctx.moveTo(curX, padY - 3);
    ctx.lineTo(curX, h - padY + 3);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.45)';
    ctx.stroke();

    const curVal = vals[curIdx] ?? Number.NaN;
    if (Number.isFinite(curVal)) {
      const curY = padY + (1 - (curVal - minV) / spanV) * plotH;
      ctx.beginPath();
      ctx.arc(curX, curY, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      sparkValReadout.textContent = `${curVal.toFixed(2)}${data.unit}`;
    } else {
      sparkValReadout.textContent = '—';
    }

    sparkMinEl.textContent = `min ${minV.toFixed(1)}${data.unit}`;
    sparkMaxEl.textContent = `max ${maxV.toFixed(1)}${data.unit}`;
  }

  function redrawAllCanvases(tSec: number, frame: SampleFrame | null): void {
    drawGGDiagram(tSec, frame);
    drawFzBars(frame);
    drawSparkline(tSec);
  }

  // -------------------------------------------------------------------------
  // Cold Session Data Binding (Pillars, Metadata, Extra Channel Selector)
  // -------------------------------------------------------------------------
  function setSessionData(data: HudSessionData): void {
    session = data;
    cachedSparkKey = '';
    cachedSparkData = null;

    // 1. Global Score Badge (with INSUFFICIENT DATA guard)
    if (data.summary.isSufficientData) {
      globalScoreBadge.textContent = `${data.summary.finalScore}/100 (${data.summary.grade})`;
      globalScoreBadge.classList.remove('is-insufficient');
    } else {
      globalScoreBadge.textContent = 'INSUFFICIENT DATA';
      globalScoreBadge.classList.add('is-insufficient');
    }

    // 2. Sanitized CSV metadata line (strict textContent; escapeHtml verified for title/summary)
    const rawParts: string[] = [];
    if (data.sessionId) rawParts.push(data.sessionId);
    if (data.driverName) rawParts.push(data.driverName);
    if (data.vehicleName) rawParts.push(data.vehicleName);
    if (data.metadata) {
      let count = 0;
      for (const [k, v] of Object.entries(data.metadata)) {
        if (!k || !v || count >= 2) continue;
        rawParts.push(`${k}=${v}`);
        count += 1;
      }
    }
    metaLine.textContent = rawParts.length > 0 ? rawParts.join(' · ') : data.vehicleSpecs.name;
    metaLine.title = formatSanitizedSessionMetadata({
      sessionId: data.sessionId,
      driverName: data.driverName,
      vehicleName: data.vehicleName,
      metadata: data.metadata,
    });

    // 3. Render 5 Driving Skill Pillars (100% textContent)
    pillarsList.replaceChildren();
    for (const pillar of data.pillars) {
      const row = el('div', 'hud-pillar-row');
      const label = el('span', 'hud-pillar-row__name', pillar.name);
      const trackBar = el('div', 'hud-pillar-row__track');
      const fill = el('div', 'hud-pillar-row__fill');
      fill.style.width = `${Math.max(0, Math.min(100, pillar.score))}%`;
      fill.style.backgroundColor = pillar.color;
      trackBar.append(fill);
      const val = el('span', 'hud-pillar-row__val tabular-nums', String(pillar.score));
      val.style.color = pillar.color;
      row.append(label, trackBar, val);
      pillarsList.append(row);
    }

    // 4. Populate Extra Channels selector dynamically (sanitized via textContent)
    sparkSelect.replaceChildren();
    const extras = data.extraChannels ?? [];
    if (extras.length > 0) {
      const extraGroup = document.createElement('optgroup');
      extraGroup.label = `CSV Extras (${extras.length})`;
      for (const ch of extras) {
        const opt = document.createElement('option');
        opt.value = `extra:${ch}`;
        opt.textContent = ch;
        extraGroup.append(opt);
      }
      sparkSelect.append(extraGroup);
    }

    const builtinGroup = document.createElement('optgroup');
    builtinGroup.label = 'Telemetria Base';
    for (const b of BUILTIN_SPARK_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = b.value;
      opt.textContent = `${b.label} (${b.unit})`;
      builtinGroup.append(opt);
    }
    sparkSelect.append(builtinGroup);

    // Auto-select first discovered extra channel when present, else Kamm Index
    selectedChannel = extras.length > 0 ? `extra:${extras[0]!}` : 'builtin:kamm';
    sparkSelect.value = selectedChannel;

    // Auto-expand HUD once a CSV session is loaded
    setCollapsed(false);
  }

  // -------------------------------------------------------------------------
  // 60 FPS Hot Path (`PlaybackClock.onTick`)
  // -------------------------------------------------------------------------
  function updateFrame(tSec: number, frame: SampleFrame | null): void {
    lastTimeSec = tSec;
    lastFrame = frame;

    if (collapsed) return;

    if (frame) {
      const speedKmh = frame.speedMs * 3.6;
      const steerDeg = frame.steerRad * RAD_TO_DEG;
      const rollDeg = frame.rollRad * RAD_TO_DEG;
      const pitchDeg = frame.pitchRad * RAD_TO_DEG;

      kpiSpeed.val.textContent = speedKmh.toFixed(1);
      kpiKamm.val.textContent = frame.kammIndex.toFixed(2);
      kpiGrade.val.textContent = `${frame.roadGradePct >= 0 ? '+' : ''}${frame.roadGradePct.toFixed(1)}`;
      kpiSteer.val.textContent = `${steerDeg >= 0 ? '+' : ''}${steerDeg.toFixed(1)}`;
      kpiAttitude.val.textContent = `${rollDeg >= 0 ? '+' : ''}${rollDeg.toFixed(1)}° / ${pitchDeg >= 0 ? '+' : ''}${pitchDeg.toFixed(1)}°`;
    }

    redrawAllCanvases(tSec, frame);
  }

  function dispose(): void {
    shell.remove();
  }

  return {
    setSessionData,
    updateFrame,
    setCollapsed,
    isCollapsed: () => collapsed,
    dispose,
  };
}

function createHudKpi(
  label: string,
  initialVal: string,
  unit: string,
): { root: HTMLElement; val: HTMLElement } {
  const root = el('div', 'hud-kpi');
  root.append(el('span', 'hud-kpi__label', label));
  const row = el('div', 'hud-kpi__row');
  const val = el('span', 'hud-kpi__val tabular-nums', initialVal);
  row.append(val);
  if (unit) {
    row.append(el('span', 'hud-kpi__unit', unit));
  }
  root.append(row);
  return { root, val };
}
