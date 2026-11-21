/**
 * Lab 2D Top-Down ao Vivo (`src/ui/topDownLab.ts` — Canvas 2D HiDPI a 60 FPS).
 * Réplica interativa em Dark Motorsport do dashboard `tools/topdown.py` do `rallysim-master`:
 * - Painel principal (esquerda topo): carro à escala, 4 pneus virados por `steerRad`,
 *   discos de aderência `grip * forceScale`, setas de força `(Fx, Fy)`, velocidade (verde),
 *   força resultante (laranja), arco de momento de guinada (roxo), grelha de 2 m e rasto 3.0 s.
 * - Série temporal sincronizada (esquerda base): Yaw rate (°/s), Lateral ay (G), Velocidade (km/h)
 *   com scrub direto por clique/arrasto (`onSeek`).
 * - Coluna direita: Mapa ENU + Diagrama G-G assimétrico, barras `Fz` das 4 rodas, e barras
 *   de inputs (`Acel.`, `Trav.`, `Direção` estilo `input_bars.py`).
 */
import type { SampleFrame } from '../core/interpolator.ts';
import { TRACK_FLAG, type TelemetryTrackSoA } from '../core/soa.ts';
import type { KammLimits } from '../core/types.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';
import {
  BODY_WIDTH_MARGIN_M,
  computeLabFrameDynamics,
  findTrackIndexAtOrBefore,
  GG_TRAIL_SEC,
  gripColorHex,
  LAB_WHEEL_IDS,
  OVERHANG_M,
  TRAIL_2D_SEC,
  VELOCITY_TIME_S,
  YAW_ARC_MAX_SWEEP_RAD,
  YAW_ARC_RADIUS_M,
  type LabRunScales,
} from './labTelemetryMath.ts';
import { RDYLGN_R_PALETTE } from './mapView.ts';

const GRAVITY_MS2 = 9.80665;
const RAD_TO_DEG = 180 / Math.PI;
const TIRE_WIDTH_M = 0.24;
const MAX_TIMESERIES_SAMPLES = 2000;
const MAX_FULL_PATH_SAMPLES = 2400;

export type TopDownWindowSizeM = 10 | 14 | 22;

export interface TopDownLabSessionData {
  sessionLabel: string;
  vehicleSpecs: ResolvedVehicleSpecs;
  kammLimits: KammLimits;
  track: TelemetryTrackSoA;
  scales: LabRunScales;
}

export interface TopDownLabOptions {
  container: HTMLElement;
  onSeek?: (tSec: number) => void;
}

export interface TopDownLabController {
  readonly element: HTMLElement;
  setSessionData(data: TopDownLabSessionData): void;
  setFollow(follow: boolean): void;
  getFollow(): boolean;
  setWindowSizeM(sizeM: TopDownWindowSizeM): void;
  getWindowSizeM(): TopDownWindowSizeM;
  updateFrame(tSec: number, frame: SampleFrame | null): void;
  resize(): void;
  dispose(): void;
}

interface CanvasSlot {
  canvas: HTMLCanvasElement;
  wrap: HTMLElement;
  cssW: number;
  cssH: number;
  dpr: number;
}

interface DownsampledTimeSeries {
  t: Float64Array;
  yawDegS: Float32Array;
  ayG: Float32Array;
  speedKmh: Float32Array;
  durationSec: number;
}

interface DownsampledPath {
  x: Float64Array;
  y: Float64Array;
  axG: Float32Array;
  ayG: Float32Array;
  gap: Uint8Array;
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

function createCanvasSlot(className: string): CanvasSlot {
  const wrap = el('div', className);
  const canvas = document.createElement('canvas');
  canvas.className = 'lab-canvas';
  wrap.append(canvas);
  return { canvas, wrap, cssW: 0, cssH: 0, dpr: 1 };
}

function syncCanvasSlot(slot: CanvasSlot, forceMeasure: boolean = false): CanvasRenderingContext2D | null {
  const dpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? Math.min(2.5, Math.max(1, window.devicePixelRatio))
      : 1;

  if (forceMeasure || slot.cssW <= 0 || slot.cssH <= 0 || slot.dpr !== dpr) {
    const rect = slot.wrap.getBoundingClientRect();
    const cssW = Math.max(40, Math.floor(rect.width));
    const cssH = Math.max(40, Math.floor(rect.height));
    if (slot.cssW !== cssW || slot.cssH !== cssH || slot.dpr !== dpr) {
      slot.cssW = cssW;
      slot.cssH = cssH;
      slot.dpr = dpr;
      slot.canvas.width = Math.round(cssW * dpr);
      slot.canvas.height = Math.round(cssH * dpr);
      slot.canvas.style.width = `${cssW}px`;
      slot.canvas.style.height = `${cssH}px`;
    }
  }

  const ctx = slot.canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(slot.dpr, 0, 0, slot.dpr, 0, 0);
  return ctx;
}

function drawArrow2D(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  lineWidth: number,
  headLen: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1.5) return;

  const angle = Math.atan2(dy, dx);
  const effectiveHead = Math.min(headLen, len * 0.48);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - Math.cos(angle) * effectiveHead * 0.65, y1 - Math.sin(angle) * effectiveHead * 0.65);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - effectiveHead * Math.cos(angle - Math.PI / 6),
    y1 - effectiveHead * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    x1 - effectiveHead * Math.cos(angle + Math.PI / 6),
    y1 - effectiveHead * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function buildDownsampledSeries(track: TelemetryTrackSoA): DownsampledTimeSeries {
  const n = track.length;
  if (n === 0) {
    return {
      t: new Float64Array(0),
      yawDegS: new Float32Array(0),
      ayG: new Float32Array(0),
      speedKmh: new Float32Array(0),
      durationSec: 0,
    };
  }
  const step = Math.max(1, Math.ceil(n / MAX_TIMESERIES_SAMPLES));
  const count = Math.ceil(n / step);
  const t = new Float64Array(count);
  const yawDegS = new Float32Array(count);
  const ayG = new Float32Array(count);
  const speedKmh = new Float32Array(count);

  let outIdx = 0;
  for (let i = 0; i < n && outIdx < count; i += step) {
    t[outIdx] = track.t[i] ?? 0;
    yawDegS[outIdx] = (track.omegaZ[i] ?? 0) * RAD_TO_DEG;
    ayG[outIdx] = (track.ay[i] ?? 0) / GRAVITY_MS2;
    speedKmh[outIdx] = (track.speedMs[i] ?? 0) * 3.6;
    outIdx += 1;
  }

  return {
    t,
    yawDegS,
    ayG,
    speedKmh,
    durationSec: Math.max(0.01, (track.t[n - 1] ?? 0) - (track.t[0] ?? 0)),
  };
}

function buildDownsampledPath(track: TelemetryTrackSoA): DownsampledPath {
  const n = track.length;
  const step = Math.max(1, Math.ceil(n / MAX_FULL_PATH_SAMPLES));
  const count = Math.ceil(n / step);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const axG = new Float32Array(count);
  const ayG = new Float32Array(count);
  const gap = new Uint8Array(count);

  let outIdx = 0;
  for (let i = 0; i < n && outIdx < count; i += step) {
    x[outIdx] = track.x[i] ?? 0;
    y[outIdx] = track.y[i] ?? 0;
    axG[outIdx] = (track.ax[i] ?? 0) / GRAVITY_MS2;
    ayG[outIdx] = (track.ay[i] ?? 0) / GRAVITY_MS2;
    gap[outIdx] = ((track.flags[i] ?? 0) & TRACK_FLAG.IS_GAP) !== 0 ? 1 : 0;
    outIdx += 1;
  }

  return { x, y, axG, ayG, gap };
}

/**
 * Creates the live 60 FPS 2D Top-Down Engineering Lab (`topdown.py` live Canvas 2D replica).
 */
export function createTopDownLab(options: TopDownLabOptions): TopDownLabController {
  let session: TopDownLabSessionData | null = null;
  let tsCache: DownsampledTimeSeries | null = null;
  let pathCache: DownsampledPath | null = null;

  let follow = true;
  let windowSizeM: TopDownWindowSizeM = 14;
  let lastTimeSec = 0;
  let lastFrame: SampleFrame | null = null;
  let isScrubbingTime = false;

  // -------------------------------------------------------------------------
  // DOM Grid (60% Left [Main 66% + TimeSeries 34%] | 40% Right [Map+GG / Fz / Inputs])
  // -------------------------------------------------------------------------
  const root = el('div', 'topdown-lab');

  const leftCol = el('div', 'topdown-lab__left');
  const mainCard = el('div', 'lab-card topdown-lab__main');
  const mainHeader = el('div', 'lab-card__header');
  mainHeader.append(el('span', 'lab-card__title', 'DINÂMICA TOP-DOWN · CARRO À ESCALA & FORÇAS'));
  const mainMeta = el('span', 'lab-card__meta tabular-nums', '—');
  mainHeader.append(mainMeta);
  const mainSlot = createCanvasSlot('lab-canvas-wrap');
  mainCard.append(mainHeader, mainSlot.wrap);

  const timeCard = el('div', 'lab-card topdown-lab__time');
  const timeHeader = el('div', 'lab-card__header');
  timeHeader.append(
    el('span', 'lab-card__title', 'SÉRIE TEMPORAL · YAW RATE / LATERAL G / VELOCIDADE'),
  );
  const timeHint = el('span', 'lab-card__meta', 'Clicar/arrastar para scrub');
  timeHeader.append(timeHint);
  const timeSlot = createCanvasSlot('lab-canvas-wrap lab-canvas-wrap--scrub');
  timeCard.append(timeHeader, timeSlot.wrap);

  leftCol.append(mainCard, timeCard);

  const rightCol = el('div', 'topdown-lab__right');

  const miniRow = el('div', 'topdown-lab__mini-row');
  const mapCard = el('div', 'lab-card');
  const mapHeader = el('div', 'lab-card__header');
  mapHeader.append(el('span', 'lab-card__title', 'TRAJETO COMPLETO (ENU)'));
  const mapSlot = createCanvasSlot('lab-canvas-wrap');
  mapCard.append(mapHeader, mapSlot.wrap);

  const ggCard = el('div', 'lab-card');
  const ggHeader = el('div', 'lab-card__header');
  ggHeader.append(el('span', 'lab-card__title', 'G-G: ACEL. (G)'));
  const ggMeta = el('span', 'lab-card__meta tabular-nums', '0.00 G');
  ggHeader.append(ggMeta);
  const ggSlot = createCanvasSlot('lab-canvas-wrap');
  ggCard.append(ggHeader, ggSlot.wrap);
  miniRow.append(mapCard, ggCard);

  const fzCard = el('div', 'lab-card topdown-lab__fz');
  const fzHeader = el('div', 'lab-card__header');
  fzHeader.append(el('span', 'lab-card__title', 'CARGA Fz POR RODA (COR = % ADERÊNCIA)'));
  const fzMeta = el('span', 'lab-card__meta tabular-nums', '— kN');
  fzHeader.append(fzMeta);
  const fzSlot = createCanvasSlot('lab-canvas-wrap');
  fzCard.append(fzHeader, fzSlot.wrap);

  // Driver inputs card (input_bars.py style: vertical Throttle/Brake + horizontal Steer)
  const inputsCard = el('div', 'lab-card topdown-lab__inputs');
  const inputsHeader = el('div', 'lab-card__header');
  inputsHeader.append(el('span', 'lab-card__title', 'INPUTS DO CONDUTOR'));
  const inputsReadout = el('span', 'lab-card__meta tabular-nums', 'Acel 0% · Trav 0% · Dir +0.0°');
  inputsHeader.append(inputsReadout);

  const inputsBody = el('div', 'lab-inputs-body');
  const pedalsGroup = el('div', 'lab-pedals');

  const throttleBar = createVerticalInputBar('Acel.', 'lab-bar-fill--throttle');
  const brakeBar = createVerticalInputBar('Trav.', 'lab-bar-fill--brake');
  pedalsGroup.append(throttleBar.root, brakeBar.root);

  const steerGroup = el('div', 'lab-steer');
  const steerHeader = el('div', 'lab-steer__header');
  steerHeader.append(el('span', 'lab-steer__label', 'DIREÇÃO'));
  const steerValEl = el('span', 'lab-steer__val tabular-nums', '+0.0°');
  steerHeader.append(steerValEl);

  const steerTrack = el('div', 'lab-steer__track');
  const steerZero = el('div', 'lab-steer__zero');
  const steerFill = el('div', 'lab-steer__fill');
  steerTrack.append(steerZero, steerFill);

  const steerTicks = el('div', 'lab-steer__ticks tabular-nums');
  const steerLeftTick = el('span', undefined, '+35° ESQ');
  const steerMidTick = el('span', undefined, '0°');
  const steerRightTick = el('span', undefined, '-35° DIR');
  steerTicks.append(steerLeftTick, steerMidTick, steerRightTick);
  steerGroup.append(steerHeader, steerTrack, steerTicks);

  inputsBody.append(pedalsGroup, steerGroup);
  inputsCard.append(inputsHeader, inputsBody);

  rightCol.append(miniRow, fzCard, inputsCard);
  root.append(leftCol, rightCol);
  options.container.append(root);

  // -------------------------------------------------------------------------
  // Interactive Time-Series Scrubbing
  // -------------------------------------------------------------------------
  const TIME_PAD_LEFT = 46;
  const TIME_PAD_RIGHT = 44;

  function seekFromPointerEvent(e: PointerEvent): void {
    if (!session || !tsCache || !options.onSeek) return;
    const rect = timeSlot.canvas.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - TIME_PAD_LEFT - TIME_PAD_RIGHT);
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - TIME_PAD_LEFT) / plotW));
    const t0 = session.track.t[0] ?? 0;
    options.onSeek(t0 + frac * tsCache.durationSec);
  }

  const onTimePointerDown = (e: PointerEvent) => {
    if (!session) return;
    isScrubbingTime = true;
    timeSlot.canvas.setPointerCapture(e.pointerId);
    seekFromPointerEvent(e);
  };
  const onTimePointerMove = (e: PointerEvent) => {
    if (!isScrubbingTime) return;
    seekFromPointerEvent(e);
  };
  const onTimePointerUp = (e: PointerEvent) => {
    if (!isScrubbingTime) return;
    isScrubbingTime = false;
    if (timeSlot.canvas.hasPointerCapture(e.pointerId)) {
      timeSlot.canvas.releasePointerCapture(e.pointerId);
    }
  };

  timeSlot.canvas.addEventListener('pointerdown', onTimePointerDown);
  timeSlot.canvas.addEventListener('pointermove', onTimePointerMove);
  timeSlot.canvas.addEventListener('pointerup', onTimePointerUp);
  timeSlot.canvas.addEventListener('pointercancel', onTimePointerUp);

  function invalidateCanvasSizes(): void {
    mainSlot.cssW = 0;
    timeSlot.cssW = 0;
    mapSlot.cssW = 0;
    ggSlot.cssW = 0;
    fzSlot.cssW = 0;
  }

  // ResizeObserver for crisp HiDPI rendering (avoids layout reads inside 60 FPS loop)
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (root.offsetWidth > 0 && root.offsetHeight > 0) {
        invalidateCanvasSizes();
        redrawAll(lastTimeSec, lastFrame);
      }
    });
    resizeObserver.observe(root);
  }

  // -------------------------------------------------------------------------
  // 1. Main Scaled Car & Tire Forces Panel
  // -------------------------------------------------------------------------
  function drawMainPanel(tSec: number, frame: SampleFrame | null): void {
    const ctx = syncCanvasSlot(mainSlot);
    if (!ctx) return;

    const w = mainSlot.cssW;
    const h = mainSlot.cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070c18';
    ctx.fillRect(0, 0, w, h);

    if (!session || !frame || !pathCache) return;

    const { vehicleSpecs, kammLimits, scales, track } = session;
    const dyn = computeLabFrameDynamics(frame, vehicleSpecs, kammLimits, scales);

    const speedKmh = frame.speedMs * 3.6;
    const ayG = frame.ay / GRAVITY_MS2;
    mainMeta.textContent = `t=${tSec.toFixed(2)}s · ${speedKmh.toFixed(1)} km/h · ay ${ayG >= 0 ? '+' : ''}${ayG.toFixed(2)}G`;

    // World-to-screen mapping (+X right, +Y up)
    let centerX = frame.x;
    let centerY = frame.y;
    let pxPerM: number;

    if (follow) {
      pxPerM = Math.min(w, h) / windowSizeM;
    } else {
      const spanX = Math.max(8, scales.maxX - scales.minX);
      const spanY = Math.max(8, scales.maxY - scales.minY);
      const padM = Math.max(4, (dyn.lf + dyn.lr + OVERHANG_M * 2) * 1.1);
      centerX = 0.5 * (scales.minX + scales.maxX);
      centerY = 0.5 * (scales.minY + scales.maxY);
      pxPerM = Math.min(w / (spanX + padM * 2), h / (spanY + padM * 2));
    }

    const toSx = (wx: number) => w * 0.5 + (wx - centerX) * pxPerM;
    const toSy = (wy: number) => h * 0.5 - (wy - centerY) * pxPerM;

    // 2 m metric grid (adaptive spacing when zoomed far out in whole-track mode)
    const minGridPx = 26;
    let gridStepM = 2;
    while (gridStepM * pxPerM < minGridPx && gridStepM < 500) {
      gridStepM *= gridStepM === 2 ? 2.5 : 2;
    }
    const halfWm = (w * 0.5) / pxPerM;
    const halfHm = (h * 0.5) / pxPerM;
    const gxStart = Math.floor((centerX - halfWm) / gridStepM) * gridStepM;
    const gxEnd = Math.ceil((centerX + halfWm) / gridStepM) * gridStepM;
    const gyStart = Math.floor((centerY - halfHm) / gridStepM) * gridStepM;
    const gyEnd = Math.ceil((centerY + halfHm) / gridStepM) * gridStepM;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.11)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = gxStart; gx <= gxEnd + 1e-6; gx += gridStepM) {
      const sx = toSx(gx);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let gy = gyStart; gy <= gyEnd + 1e-6; gy += gridStepM) {
      const sy = toSy(gy);
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();

    // Subtle full path background
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < pathCache.x.length; i++) {
      if (pathCache.gap[i] === 1) {
        pen = false;
        continue;
      }
      const sx = toSx(pathCache.x[i] ?? 0);
      const sy = toSy(pathCache.y[i] ?? 0);
      if (!pen) {
        ctx.moveTo(sx, sy);
        pen = true;
      } else {
        ctx.lineTo(sx, sy);
      }
    }
    ctx.stroke();

    // Active 3.0 s cyan trail
    if (track.length > 0) {
      const endIdx = findTrackIndexAtOrBefore(track.t, tSec);
      const minTime = tSec - TRAIL_2D_SEC;
      let startIdx = endIdx;
      while (startIdx > 0 && (track.t[startIdx - 1] ?? 0) >= minTime) {
        if (((track.flags[startIdx] ?? 0) & TRACK_FLAG.IS_GAP) !== 0) break;
        startIdx -= 1;
      }

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      let started = false;
      for (let i = startIdx; i <= endIdx; i++) {
        if (i > startIdx && ((track.flags[i] ?? 0) & TRACK_FLAG.IS_GAP) !== 0) {
          started = false;
          continue;
        }
        const sx = toSx(track.x[i] ?? 0);
        const sy = toSy(track.y[i] ?? 0);
        if (!started) {
          ctx.moveTo(sx, sy);
          started = true;
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.lineTo(toSx(frame.x), toSy(frame.y));
      ctx.stroke();
    }

    const cosY = Math.cos(frame.yaw);
    const sinY = Math.sin(frame.yaw);
    const bodyToWorld = (bx: number, by: number): [number, number] => [
      frame.x + bx * cosY - by * sinY,
      frame.y + bx * sinY + by * cosY,
    ];

    // Translucent chassis body + nose indicator
    const frontX = dyn.lf + OVERHANG_M;
    const rearX = -(dyn.lr + OVERHANG_M);
    const halfBodyW = 0.5 * Math.max(dyn.trackF, dyn.trackR) + BODY_WIDTH_MARGIN_M;

    const cFL = bodyToWorld(frontX, halfBodyW);
    const cFR = bodyToWorld(frontX, -halfBodyW);
    const cRR = bodyToWorld(rearX, -halfBodyW);
    const cRL = bodyToWorld(rearX, halfBodyW);

    ctx.save();
    ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.72)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(toSx(cFL[0]), toSy(cFL[1]));
    ctx.lineTo(toSx(cFR[0]), toSy(cFR[1]));
    ctx.lineTo(toSx(cRR[0]), toSy(cRR[1]));
    ctx.lineTo(toSx(cRL[0]), toSy(cRL[1]));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Front nose highlight strip
    const nL = bodyToWorld(frontX, halfBodyW * 0.75);
    const nR = bodyToWorld(frontX, -halfBodyW * 0.75);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(toSx(nL[0]), toSy(nL[1]));
    ctx.lineTo(toSx(nR[0]), toSy(nR[1]));
    ctx.stroke();
    ctx.restore();

    // 4 wheels: grip discs, rotated tire rectangles, and white tire force vectors (Fx, Fy)
    const wheelHalfLen = dyn.tireRadiusM;
    const wheelHalfWid = TIRE_WIDTH_M * 0.5;
    const k = scales.forceScale;

    for (const id of LAB_WHEEL_IDS) {
      const wd = dyn.wheels[id];
      const [pxM, pyM] = bodyToWorld(wd.wx, wd.wy);
      const sx = toSx(pxM);
      const sy = toSy(pyM);
      const col = wd.fz > 0 ? gripColorHex(wd.gripUse) : '#64748b';

      // Grip disc of radius `grip * forceScale`
      if (wd.grip > 1e-3) {
        const discR = wd.grip * k * pxPerM;
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, discR, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.18;
        ctx.fill();
        ctx.globalAlpha = 0.65;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }

      // Scaled tire rectangle rotated by yaw + steer (front wheels)
      const isFront = id === 'FL' || id === 'FR';
      const wHeading = frame.yaw + (isFront ? dyn.steerRad : 0);
      ctx.save();
      ctx.translate(sx, sy);
      // Screen Y is inverted vs world +Y, so CCW +yaw is negative canvas rotation
      ctx.rotate(-wHeading);
      ctx.fillStyle = col;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.3;
      ctx.fillRect(
        -wheelHalfLen * pxPerM,
        -wheelHalfWid * pxPerM,
        wheelHalfLen * 2 * pxPerM,
        wheelHalfWid * 2 * pxPerM,
      );
      ctx.strokeRect(
        -wheelHalfLen * pxPerM,
        -wheelHalfWid * pxPerM,
        wheelHalfLen * 2 * pxPerM,
        wheelHalfWid * 2 * pxPerM,
      );
      ctx.restore();

      // White tire force vector (fx, fy) in world frame (scaled by forceScale)
      const fxW = (wd.fx * cosY - wd.fy * sinY) * k;
      const fyW = (wd.fx * sinY + wd.fy * cosY) * k;
      drawArrow2D(ctx, sx, sy, toSx(pxM + fxW), toSy(pyM + fyW), '#f8fafc', 2.4, 9);
    }

    // CG vectors: green velocity (v * 0.15 s), orange net force, purple yaw moment arc
    const cgSx = toSx(frame.x);
    const cgSy = toSy(frame.y);

    const velWorldX = frame.speedMs * cosY * VELOCITY_TIME_S;
    const velWorldY = frame.speedMs * sinY * VELOCITY_TIME_S;
    drawArrow2D(
      ctx,
      cgSx,
      cgSy,
      toSx(frame.x + velWorldX),
      toSy(frame.y + velWorldY),
      '#10b981',
      2.6,
      10,
    );

    const netWorldX = (dyn.netFx * cosY - dyn.netFy * sinY) * k;
    const netWorldY = (dyn.netFx * sinY + dyn.netFy * cosY) * k;
    drawArrow2D(
      ctx,
      cgSx,
      cgSy,
      toSx(frame.x + netWorldX),
      toSy(frame.y + netWorldY),
      '#f97316',
      3.0,
      11,
    );

    // Purple yaw moment arc (r = 0.9 m, sweep = 270° * momentShare, hidden if <= 0.02)
    if (dyn.momentShare > 0.02) {
      const turn = dyn.yawMoment >= 0 ? 1 : -1;
      const sweep = YAW_ARC_MAX_SWEEP_RAD * dyn.momentShare;
      const steps = 36;
      ctx.save();
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      let endAngle = frame.yaw;
      for (let i = 0; i <= steps; i++) {
        const frac = i / steps;
        const a = frame.yaw + turn * (-sweep * 0.5 + frac * sweep);
        endAngle = a;
        const axM = frame.x + YAW_ARC_RADIUS_M * Math.cos(a);
        const ayM = frame.y + YAW_ARC_RADIUS_M * Math.sin(a);
        const asx = toSx(axM);
        const asy = toSy(ayM);
        if (i === 0) ctx.moveTo(asx, asy);
        else ctx.lineTo(asx, asy);
      }
      ctx.stroke();

      // Directional tangent arrowhead at end of arc
      const exM = frame.x + YAW_ARC_RADIUS_M * Math.cos(endAngle);
      const eyM = frame.y + YAW_ARC_RADIUS_M * Math.sin(endAngle);
      const txM = turn * -Math.sin(endAngle) * 0.35;
      const tyM = turn * Math.cos(endAngle) * 0.35;
      drawArrow2D(ctx, toSx(exM), toSy(eyM), toSx(exM + txM), toSy(eyM + tyM), '#a855f7', 2.8, 10);
      ctx.restore();
    }

    // CG dot
    ctx.beginPath();
    ctx.arc(cgSx, cgSy, 3.8, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.strokeStyle = '#020617';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Compact legend box (bottom-left): force scale + arrow colors
    const kNPerM = 1 / (k * 1000);
    const legendLines: ReadonlyArray<{ color: string; text: string }> = [
      { color: '#cbd5e1', text: `Escala: 1 m = ${kNPerM.toFixed(1)} kN · grelha ${gridStepM} m` },
      { color: '#f8fafc', text: 'Branco: força pneu (Fx, Fy)' },
      { color: '#10b981', text: 'Verde: velocidade (0.15 s)' },
      { color: '#f97316', text: 'Laranja: resultante 4 pneus' },
      { color: '#a855f7', text: 'Roxo: momento guinada' },
    ];
    const lx = 10;
    const ly = h - legendLines.length * 14 - 14;
    ctx.fillStyle = 'rgba(10, 17, 34, 0.82)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    ctx.fillRect(lx, ly, 214, legendLines.length * 14 + 8);
    ctx.strokeRect(lx, ly, 214, legendLines.length * 14 + 8);
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < legendLines.length; i++) {
      const item = legendLines[i]!;
      ctx.fillStyle = item.color;
      ctx.fillText(item.text, lx + 8, ly + 5 + i * 14);
    }

    // Horizontal 0%–100% grip utilization colorbar (bottom-right)
    const barW = Math.min(154, w * 0.26);
    const barH = 8;
    const bx = w - barW - 14;
    const by = h - 24;
    const grad = ctx.createLinearGradient(bx, 0, bx + barW, 0);
    for (let i = 0; i < RDYLGN_R_PALETTE.length; i++) {
      grad.addColorStop(i / Math.max(1, RDYLGN_R_PALETTE.length - 1), RDYLGN_R_PALETTE[i]!);
    }
    ctx.fillStyle = 'rgba(10, 17, 34, 0.82)';
    ctx.fillRect(bx - 8, by - 18, barW + 16, 36);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.strokeRect(bx - 8, by - 18, barW + 16, 36);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '700 9.5px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Uso de aderência (%)', bx + barW * 0.5, by - 14);
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 9px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0%', bx, by + 10);
    ctx.textAlign = 'center';
    ctx.fillText('50%', bx + barW * 0.5, by + 10);
    ctx.textAlign = 'right';
    ctx.fillText('100%', bx + barW, by + 10);
  }

  // -------------------------------------------------------------------------
  // 2. Synchronized Time Series (Yaw rate, Lateral G, Speed km/h + scrub)
  // -------------------------------------------------------------------------
  function drawTimeSeries(tSec: number): void {
    const ctx = syncCanvasSlot(timeSlot);
    if (!ctx) return;

    const w = timeSlot.cssW;
    const h = timeSlot.cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070c18';
    ctx.fillRect(0, 0, w, h);

    if (!session || !tsCache || tsCache.t.length < 2) return;

    const padT = 18;
    const padB = 20;
    const plotW = Math.max(10, w - TIME_PAD_LEFT - TIME_PAD_RIGHT);
    const plotH = Math.max(10, h - padT - padB);
    const t0 = tsCache.t[0] ?? 0;
    const dur = tsCache.durationSec;

    const xOfT = (t: number) => TIME_PAD_LEFT + ((t - t0) / dur) * plotW;

    // Grid & zero line
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(TIME_PAD_LEFT, padT, plotW, plotH);
    const midY = padT + plotH * 0.5;
    ctx.beginPath();
    ctx.moveTo(TIME_PAD_LEFT, midY);
    ctx.lineTo(TIME_PAD_LEFT + plotW, midY);
    ctx.stroke();

    const maxYaw = session.scales.maxAbsYawRateDegS;
    const maxAy = session.scales.maxAbsAyG;
    const maxSpd = session.scales.maxSpeedKmh;
    const n = tsCache.t.length;

    // 1. Speed (km/h) — right axis (#38bdf8)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const sx = xOfT(tsCache.t[i] ?? t0);
      const sy = padT + plotH - ((tsCache.speedKmh[i] ?? 0) / maxSpd) * plotH;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // 2. Lateral ay (G) — left centered axis (#f59e0b)
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const sx = xOfT(tsCache.t[i] ?? t0);
      const sy = midY - ((tsCache.ayG[i] ?? 0) / maxAy) * (plotH * 0.46);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // 3. Yaw rate (°/s) — left centered axis (#a855f7)
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const sx = xOfT(tsCache.t[i] ?? t0);
      const sy = midY - ((tsCache.yawDegS[i] ?? 0) / maxYaw) * (plotH * 0.46);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // Red vertical playhead cursor
    const curX = Math.max(TIME_PAD_LEFT, Math.min(TIME_PAD_LEFT + plotW, xOfT(tSec)));
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(curX, padT);
    ctx.lineTo(curX, padT + plotH);
    ctx.stroke();

    // Axis ticks & top legend
    ctx.font = '600 9px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#a855f7';
    ctx.fillText(`+${maxYaw.toFixed(0)}°/s`, TIME_PAD_LEFT - 4, padT + 4);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('0', TIME_PAD_LEFT - 4, midY);
    ctx.fillStyle = '#a855f7';
    ctx.fillText(`-${maxYaw.toFixed(0)}°/s`, TIME_PAD_LEFT - 4, padT + plotH - 4);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`${maxSpd.toFixed(0)} km/h`, TIME_PAD_LEFT + plotW + 4, padT + 4);
    ctx.fillText('0', TIME_PAD_LEFT + plotW + 4, padT + plotH - 4);

    // Inline top legend
    ctx.textBaseline = 'top';
    let lx = TIME_PAD_LEFT + 6;
    const legendItems: ReadonlyArray<[string, string]> = [
      ['#a855f7', 'Yaw (°/s)'],
      ['#f59e0b', `ay (±${maxAy.toFixed(2)}G)`],
      ['#38bdf8', 'Vel (km/h)'],
    ];
    for (const [col, lbl] of legendItems) {
      ctx.fillStyle = col;
      ctx.fillText(lbl, lx, 4);
      lx += ctx.measureText(lbl).width + 12;
    }

    // Time labels along bottom
    ctx.fillStyle = '#64748b';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText('0s', TIME_PAD_LEFT, h - 3);
    ctx.textAlign = 'center';
    ctx.fillText(`${(dur * 0.5).toFixed(0)}s`, TIME_PAD_LEFT + plotW * 0.5, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText(`${dur.toFixed(0)}s`, TIME_PAD_LEFT + plotW, h - 3);
  }

  // -------------------------------------------------------------------------
  // 3a. Mini Map ENU (Whole Track + Start Green + Current Red + Follow Box)
  // -------------------------------------------------------------------------
  function drawMiniMap(frame: SampleFrame | null): void {
    const ctx = syncCanvasSlot(mapSlot);
    if (!ctx) return;

    const w = mapSlot.cssW;
    const h = mapSlot.cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070c18';
    ctx.fillRect(0, 0, w, h);

    if (!session || !pathCache || pathCache.x.length === 0) return;

    const { scales } = session;
    const spanX = Math.max(4, scales.maxX - scales.minX);
    const spanY = Math.max(4, scales.maxY - scales.minY);
    const pad = 12;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const cx = 0.5 * (scales.minX + scales.maxX);
    const cy = 0.5 * (scales.minY + scales.maxY);

    const toX = (x: number) => w * 0.5 + (x - cx) * scale;
    const toY = (y: number) => h * 0.5 - (y - cy) * scale;

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < pathCache.x.length; i++) {
      if (pathCache.gap[i] === 1) {
        pen = false;
        continue;
      }
      const sx = toX(pathCache.x[i] ?? 0);
      const sy = toY(pathCache.y[i] ?? 0);
      if (!pen) {
        ctx.moveTo(sx, sy);
        pen = true;
      } else {
        ctx.lineTo(sx, sy);
      }
    }
    ctx.stroke();

    // Start green dot
    ctx.beginPath();
    ctx.arc(toX(pathCache.x[0] ?? 0), toY(pathCache.y[0] ?? 0), 3.8, 0, Math.PI * 2);
    ctx.fillStyle = '#10b981';
    ctx.fill();

    if (frame) {
      const fx = toX(frame.x);
      const fy = toY(frame.y);

      // Red window rectangle in Follow mode
      if (follow) {
        const boxPx = Math.max(8, windowSizeM * scale);
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(fx - boxPx * 0.5, fy - boxPx * 0.5, boxPx, boxPx);
      }

      // Current red dot
      ctx.beginPath();
      ctx.arc(fx, fy, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = '#f43f5e';
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // -------------------------------------------------------------------------
  // 3b. Mini G-G Diagram (Asymmetric Kamm + 0.5G/1G + Full Trace + 2s Trail)
  // -------------------------------------------------------------------------
  function drawMiniGG(tSec: number, frame: SampleFrame | null): void {
    const ctx = syncCanvasSlot(ggSlot);
    if (!ctx) return;

    const w = ggSlot.cssW;
    const h = ggSlot.cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070c18';
    ctx.fillRect(0, 0, w, h);

    if (!session || !pathCache) return;

    const { kammLimits, track } = session;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const plotR = Math.min(w, h) * 0.4;
    const maxScaleG = Math.max(1.15, kammLimits.gripLimitG * 1.15);
    const pxPerG = plotR / maxScaleG;

    // 0.5 G dotted and 1.0 G dashed rings
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, 0.5 * pxPerG, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(plotR, 1.0 * pxPerG), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Crosshairs
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.beginPath();
    ctx.moveTo(cx - plotR, cy);
    ctx.lineTo(cx + plotR, cy);
    ctx.moveTo(cx, cy - plotR);
    ctx.lineTo(cx, cy + plotR);
    ctx.stroke();

    // Asymmetric Kamm Safety Envelope (top accelLimit, bottom brakeLimit, width ±latLimit)
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const theta = (i / 48) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const px = cx - kammLimits.latLimit * pxPerG * cosT;
      const py =
        sinT >= 0
          ? cy - kammLimits.accelLimit * pxPerG * sinT
          : cy - kammLimits.brakeLimit * pxPerG * sinT;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Subtle full-run G-G trace (+ay left = -X, +ax up = -Y)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < pathCache.axG.length; i++) {
      if (pathCache.gap[i] === 1) {
        pen = false;
        continue;
      }
      const gx = cx - (pathCache.ayG[i] ?? 0) * pxPerG;
      const gy = cy - (pathCache.axG[i] ?? 0) * pxPerG;
      if (!pen) {
        ctx.moveTo(gx, gy);
        pen = true;
      } else {
        ctx.lineTo(gx, gy);
      }
    }
    ctx.stroke();

    // Active 2.0 s trail
    if (track.length > 0) {
      const endIdx = findTrackIndexAtOrBefore(track.t, tSec);
      const minTime = tSec - GG_TRAIL_SEC;
      let startIdx = endIdx;
      while (startIdx > 0 && (track.t[startIdx - 1] ?? 0) >= minTime) {
        if (((track.flags[startIdx] ?? 0) & TRACK_FLAG.IS_GAP) !== 0) break;
        startIdx -= 1;
      }

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let started = false;
      for (let i = startIdx; i <= endIdx; i++) {
        if (i > startIdx && ((track.flags[i] ?? 0) & TRACK_FLAG.IS_GAP) !== 0) {
          started = false;
          continue;
        }
        const gx = cx - ((track.ay[i] ?? 0) / GRAVITY_MS2) * pxPerG;
        const gy = cy - ((track.ax[i] ?? 0) / GRAVITY_MS2) * pxPerG;
        if (!started) {
          ctx.moveTo(gx, gy);
          started = true;
        } else {
          ctx.lineTo(gx, gy);
        }
      }
      ctx.stroke();
    }

    // Current red dot (clamped radially to plotR so extremes stay visible)
    if (frame) {
      const axG = frame.ax / GRAVITY_MS2;
      const ayG = frame.ay / GRAVITY_MS2;
      const netG = Math.hypot(axG, ayG);
      ggMeta.textContent = `${netG.toFixed(2)} G`;

      const r = Math.hypot(ayG, axG);
      const scaleClamp = r > maxScaleG ? maxScaleG / r : 1;
      const dx = cx - ayG * scaleClamp * pxPerG;
      const dy = cy - axG * scaleClamp * pxPerG;

      ctx.beginPath();
      ctx.arc(dx, dy, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = '#f43f5e';
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = '#64748b';
    ctx.font = '700 8.5px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('ACC +', cx, 3);
    ctx.textBaseline = 'bottom';
    ctx.fillText('BRK -', cx, h - 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('L+', 4, cy);
    ctx.textAlign = 'right';
    ctx.fillText('R-', w - 4, cy);
  }

  // -------------------------------------------------------------------------
  // 4. 4-Wheel Fz Bar Chart
  // -------------------------------------------------------------------------
  function drawFzChart(frame: SampleFrame | null): void {
    const ctx = syncCanvasSlot(fzSlot);
    if (!ctx) return;

    const w = fzSlot.cssW;
    const h = fzSlot.cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070c18';
    ctx.fillRect(0, 0, w, h);

    if (!session || !frame) return;

    const dyn = computeLabFrameDynamics(frame, session.vehicleSpecs, session.kammLimits, session.scales);
    const totalKn =
      (dyn.wheels.FL.fz + dyn.wheels.FR.fz + dyn.wheels.RL.fz + dyn.wheels.RR.fz) / 1000;
    fzMeta.textContent = `Σ ${totalKn.toFixed(2)} kN`;

    const maxKn = Math.max(1, (session.scales.maxFz / 1000) * 1.25);
    const padX = 16;
    const topY = 28;
    const botY = h - 22;
    const barAreaH = Math.max(12, botY - topY);
    const colW = (w - padX * 2) / 4;
    const barW = Math.min(44, colW - 14);

    // Baseline & mid guide
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, botY);
    ctx.lineTo(w - padX, botY);
    ctx.moveTo(padX, topY + barAreaH * 0.5);
    ctx.lineTo(w - padX, topY + barAreaH * 0.5);
    ctx.stroke();

    for (let i = 0; i < 4; i++) {
      const id = LAB_WHEEL_IDS[i]!;
      const wd = dyn.wheels[id];
      const fzKn = wd.fz / 1000;
      const cx = padX + colW * (i + 0.5);
      const x0 = cx - barW * 0.5;
      const frac = Math.max(0, Math.min(1, fzKn / maxKn));
      const barH = frac * barAreaH;
      const col = wd.fz > 0 ? gripColorHex(wd.gripUse) : '#64748b';

      ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
      ctx.fillRect(x0, topY, barW, barAreaH);
      ctx.strokeRect(x0, topY, barW, barAreaH);

      if (barH > 0.5) {
        ctx.fillStyle = col;
        ctx.fillRect(x0 + 1, botY - barH, barW - 2, barH);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#f1f5f9';
      ctx.font = '700 9.5px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(`${fzKn.toFixed(2)} kN`, cx, Math.max(12, botY - barH - 12));

      ctx.fillStyle = wd.stateLabel ? '#fda4af' : col;
      ctx.font = '700 9px ui-monospace, SFMono-Regular, monospace';
      const pctText = `${Math.round(wd.gripUse * 100)}%${wd.stateLabel ? ` ${wd.stateLabel}` : ''}`;
      ctx.fillText(pctText, cx, Math.max(22, botY - barH - 2));

      ctx.textBaseline = 'top';
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '800 10px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(id, cx, botY + 5);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Driver Inputs Bars (DOM, input_bars.py style)
  // -------------------------------------------------------------------------
  function updateInputBars(frame: SampleFrame | null): void {
    if (!session || !frame) return;
    const dyn = computeLabFrameDynamics(frame, session.vehicleSpecs, session.kammLimits, session.scales);

    const thrPct = Math.round(dyn.throttle * 100);
    const brkPct = Math.round(dyn.brake * 100);
    const steerDeg = dyn.steerRad * RAD_TO_DEG;
    const maxSteerDeg = dyn.maxSteerRad * RAD_TO_DEG;

    throttleBar.fill.style.height = `${thrPct}%`;
    throttleBar.val.textContent = `${thrPct}%`;
    brakeBar.fill.style.height = `${brkPct}%`;
    brakeBar.val.textContent = `${brkPct}%`;

    // +steerRad = Left turn => bar extends to the LEFT from center (50%)
    const halfPct = Math.abs(dyn.steerNorm) * 50;
    if (dyn.steerNorm >= 0) {
      steerFill.style.left = `${50 - halfPct}%`;
      steerFill.style.width = `${halfPct}%`;
    } else {
      steerFill.style.left = '50%';
      steerFill.style.width = `${halfPct}%`;
    }

    steerValEl.textContent = `${steerDeg >= 0 ? '+' : ''}${steerDeg.toFixed(1)}°`;
    steerLeftTick.textContent = `+${maxSteerDeg.toFixed(0)}° ESQ`;
    steerRightTick.textContent = `-${maxSteerDeg.toFixed(0)}° DIR`;
    inputsReadout.textContent = `Acel ${thrPct}% · Trav ${brkPct}% · Dir ${steerDeg >= 0 ? '+' : ''}${steerDeg.toFixed(1)}°`;
  }

  function redrawAll(tSec: number, frame: SampleFrame | null): void {
    drawMainPanel(tSec, frame);
    drawTimeSeries(tSec);
    drawMiniMap(frame);
    drawMiniGG(tSec, frame);
    drawFzChart(frame);
    updateInputBars(frame);
  }

  function setSessionData(data: TopDownLabSessionData): void {
    session = data;
    tsCache = buildDownsampledSeries(data.track);
    pathCache = buildDownsampledPath(data.track);
    if (root.offsetWidth > 0 && root.offsetHeight > 0) {
      redrawAll(lastTimeSec, lastFrame);
    }
  }

  function updateFrame(tSec: number, frame: SampleFrame | null): void {
    lastTimeSec = tSec;
    lastFrame = frame;
    if (root.offsetWidth <= 0 || root.offsetHeight <= 0) return;
    redrawAll(tSec, frame);
  }

  function dispose(): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    timeSlot.canvas.removeEventListener('pointerdown', onTimePointerDown);
    timeSlot.canvas.removeEventListener('pointermove', onTimePointerMove);
    timeSlot.canvas.removeEventListener('pointerup', onTimePointerUp);
    timeSlot.canvas.removeEventListener('pointercancel', onTimePointerUp);
    root.remove();
  }

  return {
    element: root,
    setSessionData,
    setFollow: (nextFollow: boolean) => {
      follow = nextFollow;
      redrawAll(lastTimeSec, lastFrame);
    },
    getFollow: () => follow,
    setWindowSizeM: (sizeM: TopDownWindowSizeM) => {
      windowSizeM = sizeM;
      redrawAll(lastTimeSec, lastFrame);
    },
    getWindowSizeM: () => windowSizeM,
    updateFrame,
    resize: () => {
      invalidateCanvasSizes();
      redrawAll(lastTimeSec, lastFrame);
    },
    dispose,
  };
}

function createVerticalInputBar(
  label: string,
  fillModifierClass: string,
): { root: HTMLElement; fill: HTMLElement; val: HTMLElement } {
  const root = el('div', 'lab-pedal');
  const val = el('span', 'lab-pedal__val tabular-nums', '0%');
  const track = el('div', 'lab-pedal__track');
  const fill = el('div', `lab-pedal__fill ${fillModifierClass}`);
  fill.style.height = '0%';
  track.append(fill);
  const lbl = el('span', 'lab-pedal__label', label);
  root.append(val, track, lbl);
  return { root, fill, val };
}
