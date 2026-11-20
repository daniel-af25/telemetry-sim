/**
 * Gravador e exportador nativo de vídeo WebM (2D e 3D) com compositor offscreen `<canvas>`
 * + barra discreta de telemetria (`TELEMETRY-SIM`, modo 2D/3D, velocidade, Kamm, G, declive e tempo).
 * 100% nativo (`MediaRecorder` + `captureStream(30)`), zero dependências externas.
 *
 * Testes:
 *   npx vitest run test/ui/videoRecorder.test.ts
 */

const PREFERRED_VIDEO_MIMES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

const TARGET_FPS = 30;
const VIDEO_BITRATE_BPS = 6_000_000;
const MAX_VIDEO_WIDTH = 1920;
const MAX_VIDEO_HEIGHT = 1080;

export interface VideoOverlaySnapshot {
  sessionLabel: string;
  vehicleName: string;
  is3D: boolean;
  speedKmh: number;
  kammIndex: number;
  latG: number;
  lonG: number;
  roadGradePct: number;
  timeSec: number;
  durationSec: number;
}

export interface MediaRecorderLike {
  readonly state: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((ev: Event) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface TripVideoRecorderOptions {
  getSourceCanvas: () => HTMLCanvasElement;
  getOverlayData: () => VideoOverlaySnapshot;
  onStateChange?: (recording: boolean, elapsedSec: number) => void;
  onError?: (message: string) => void;
  isTypeSupported?: (mimeType: string) => boolean;
  createMediaRecorder?: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorderLike;
  triggerDownload?: (blob: Blob, filename: string) => void;
}

export interface TripVideoRecorder {
  start(): boolean;
  stopAndDownload(filenameBase?: string): Promise<string | null>;
  isRecording(): boolean;
  dispose(): void;
}

/**
 * Picks the highest-quality WebM MIME type supported by the browser's `MediaRecorder`.
 */
export function selectSupportedVideoMimeType(
  isTypeSupported?: (mime: string) => boolean,
): string | null {
  const checker =
    isTypeSupported ??
    (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? (mime: string) => MediaRecorder.isTypeSupported(mime)
      : null);

  if (!checker) return null;

  for (const mime of PREFERRED_VIDEO_MIMES) {
    try {
      if (checker(mime)) return mime;
    } catch {
      // Ignore individual MIME probe failures
    }
  }
  return null;
}

/**
 * Builds a filesystem-safe `.webm` filename from a session label and 2D/3D mode.
 */
export function buildVideoFilename(
  sessionLabel: string | null | undefined,
  is3D: boolean,
): string {
  const raw = (sessionLabel ?? '').trim();
  const sanitized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

  const base = sanitized || 'trip';
  const modeTag = is3D ? '3d' : '2d';
  return `telemetry_${base}_${modeTag}.webm`;
}

function formatOverlayTime(sec: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const mins = Math.floor(safe / 60);
  const wholeSec = Math.floor(safe % 60);
  return `${String(mins).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}`;
}

function computeEvenDimensions(
  srcW: number,
  srcH: number,
): { width: number; height: number } {
  const safeW = Math.max(320, Math.floor(srcW));
  const safeH = Math.max(180, Math.floor(srcH));
  const scale = Math.min(1, MAX_VIDEO_WIDTH / safeW, MAX_VIDEO_HEIGHT / safeH);
  const w = Math.max(2, Math.floor((safeW * scale) / 2) * 2);
  const h = Math.max(2, Math.floor((safeH * scale) / 2) * 2);
  return { width: w, height: h };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTelemetryWatermark(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  data: VideoOverlaySnapshot,
): void {
  const pad = 16;
  const boxW = Math.min(canvasW - pad * 2, 560);
  const boxH = 66;
  const x = pad;
  const y = canvasH - boxH - pad;

  ctx.save();

  // Dark glass panel background
  drawRoundedRect(ctx, x, y, boxW, boxH, 10);
  ctx.fillStyle = 'rgba(7, 12, 24, 0.84)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
  ctx.stroke();

  // Top line: brand + mode pill + vehicle/session
  ctx.font = '700 11px ui-monospace, SFMono-Regular, Consolas, monospace';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(`TELEMETRY-SIM • ${data.is3D ? '3D' : '2D'}`, x + 12, y + 20);

  const headerInfo = data.vehicleName || data.sessionLabel || 'Session';
  ctx.font = '600 11px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#cbd5e1';
  const maxLabelChars = Math.max(16, Math.floor((boxW - 180) / 6.5));
  const clippedLabel =
    headerInfo.length > maxLabelChars
      ? `${headerInfo.slice(0, maxLabelChars - 1)}…`
      : headerInfo;
  ctx.fillText(clippedLabel, x + 158, y + 20);

  // Bottom line: live metrics readout
  const latStr = `${data.latG >= 0 ? '+' : ''}${data.latG.toFixed(2)}G`;
  const lonStr = `${data.lonG >= 0 ? '+' : ''}${data.lonG.toFixed(2)}G`;
  const gradeStr = `${data.roadGradePct >= 0 ? '+' : ''}${data.roadGradePct.toFixed(1)}%`;
  const timeStr = `${formatOverlayTime(data.timeSec)} / ${formatOverlayTime(data.durationSec)}`;

  ctx.font = '700 12px ui-monospace, SFMono-Regular, Consolas, monospace';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(`${data.speedKmh.toFixed(1)} km/h`, x + 12, y + 46);

  ctx.fillStyle =
    data.kammIndex > 1.0 ? '#f43f5e' : data.kammIndex >= 0.75 ? '#f59e0b' : '#10b981';
  ctx.fillText(`KAMM ${data.kammIndex.toFixed(2)}×`, x + 104, y + 46);

  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`LAT ${latStr}  LON ${lonStr}  ${gradeStr}`, x + 196, y + 46);

  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'right';
  ctx.fillText(timeStr, x + boxW - 12, y + 46);

  ctx.restore();
}

function createNativeMediaRecorder(
  stream: MediaStream,
  opts: MediaRecorderOptions,
): MediaRecorderLike {
  const native = new MediaRecorder(stream, opts);
  const adapter: MediaRecorderLike = {
    get state() {
      return native.state;
    },
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start(timeslice?: number) {
      native.ondataavailable = (ev: BlobEvent) => {
        adapter.ondataavailable?.({ data: ev.data });
      };
      native.onstop = () => {
        adapter.onstop?.();
      };
      native.onerror = (ev: Event) => {
        adapter.onerror?.(ev);
      };
      native.start(timeslice);
    },
    stop() {
      native.stop();
    },
  };
  return adapter;
}

function defaultTriggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 5000);
}

/**
 * Creates a browser-native WebM video recorder that composites the MapLibre
 * WebGL canvas and a telemetry HUD watermark at 30 FPS.
 */
export function createTripVideoRecorder(
  options: TripVideoRecorderOptions,
): TripVideoRecorder {
  let recording = false;
  let rafId: number | null = null;
  let startedAtMs = 0;
  let lastReportedSec = -1;
  let activeMimeType = 'video/webm';
  let chunks: Blob[] = [];
  let mediaRecorder: MediaRecorderLike | null = null;
  let activeStream: MediaStream | null = null;
  let compositorCanvas: HTMLCanvasElement | null = null;
  let compositorCtx: CanvasRenderingContext2D | null = null;
  let stopPromise: Promise<string | null> | null = null;

  function stopStreamTracks(): void {
    if (!activeStream) return;
    for (const track of activeStream.getTracks()) {
      track.stop();
    }
    activeStream = null;
  }

  function cancelRenderLoop(): void {
    if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(rafId);
    }
    rafId = null;
  }

  function renderCompositeFrame(): boolean {
    if (!compositorCanvas || !compositorCtx) return false;
    const srcCanvas = options.getSourceCanvas();
    const w = compositorCanvas.width;
    const h = compositorCanvas.height;

    try {
      compositorCtx.fillStyle = '#070c18';
      compositorCtx.fillRect(0, 0, w, h);
      compositorCtx.drawImage(srcCanvas, 0, 0, w, h);
    } catch (err) {
      const msg =
        err instanceof Error
          ? `Falha ao capturar canvas (CORS/WebGL): ${err.message}`
          : 'Falha ao capturar canvas do mapa para vídeo.';
      options.onError?.(msg);
      return false;
    }

    const overlay = options.getOverlayData();
    drawTelemetryWatermark(compositorCtx, w, h, overlay);
    return true;
  }

  function start(): boolean {
    if (recording) return true;

    const mimeType = selectSupportedVideoMimeType(options.isTypeSupported);
    if (!mimeType) {
      options.onError?.(
        'Gravação WebM não suportada neste browser (MediaRecorder indisponível).',
      );
      return false;
    }

    const srcCanvas = options.getSourceCanvas();
    const { width, height } = computeEvenDimensions(
      srcCanvas.width || srcCanvas.clientWidth || 1280,
      srcCanvas.height || srcCanvas.clientHeight || 720,
    );

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      options.onError?.('Não foi possível inicializar o contexto 2D do gravador de vídeo.');
      return false;
    }

    if (typeof canvas.captureStream !== 'function') {
      options.onError?.('captureStream() não suportado neste browser.');
      return false;
    }

    compositorCanvas = canvas;
    compositorCtx = ctx;
    activeMimeType = mimeType;
    chunks = [];

    // Draw initial frame before starting MediaRecorder
    if (!renderCompositeFrame()) {
      compositorCanvas = null;
      compositorCtx = null;
      return false;
    }

    let stream: MediaStream;
    try {
      stream = canvas.captureStream(TARGET_FPS);
    } catch (err) {
      const msg =
        err instanceof Error
          ? `Erro ao iniciar captureStream: ${err.message}`
          : 'Erro ao iniciar stream de vídeo.';
      options.onError?.(msg);
      return false;
    }

    const recorderFactory =
      options.createMediaRecorder ?? createNativeMediaRecorder;

    let recorder: MediaRecorderLike;
    try {
      recorder = recorderFactory(stream, {
        mimeType,
        videoBitsPerSecond: VIDEO_BITRATE_BPS,
      });
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      const msg =
        err instanceof Error
          ? `Erro ao iniciar MediaRecorder: ${err.message}`
          : 'Erro ao inicializar MediaRecorder.';
      options.onError?.(msg);
      return false;
    }

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };

    recorder.onerror = () => {
      options.onError?.('Erro durante a codificação do vídeo WebM.');
    };

    activeStream = stream;
    mediaRecorder = recorder;
    recording = true;
    startedAtMs = performance.now();
    lastReportedSec = 0;

    recorder.start(250);
    options.onStateChange?.(true, 0);

    const tick = () => {
      rafId = null;
      if (!recording) return;

      const ok = renderCompositeFrame();
      if (!ok) {
        void stopAndDownload();
        return;
      }

      const elapsed = Math.max(0, (performance.now() - startedAtMs) / 1000);
      const wholeSec = Math.floor(elapsed);
      if (wholeSec !== lastReportedSec) {
        lastReportedSec = wholeSec;
        options.onStateChange?.(true, elapsed);
      }

      if (recording && typeof globalThis.requestAnimationFrame === 'function') {
        rafId = globalThis.requestAnimationFrame(tick);
      }
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      rafId = globalThis.requestAnimationFrame(tick);
    }

    return true;
  }

  function stopAndDownload(filenameBase?: string): Promise<string | null> {
    if (stopPromise) return stopPromise;
    if (!recording || !mediaRecorder) {
      return Promise.resolve(null);
    }

    recording = false;
    cancelRenderLoop();

    const recorder = mediaRecorder;
    const overlay = options.getOverlayData();
    const filename = buildVideoFilename(
      filenameBase ?? overlay.sessionLabel,
      overlay.is3D,
    );
    const elapsedSec = Math.max(0, (performance.now() - startedAtMs) / 1000);

    stopPromise = new Promise<string | null>((resolve) => {
      const finalize = () => {
        stopStreamTracks();
        const blob = new Blob(chunks, { type: activeMimeType });
        chunks = [];
        mediaRecorder = null;
        compositorCanvas = null;
        compositorCtx = null;
        stopPromise = null;

        options.onStateChange?.(false, elapsedSec);

        if (blob.size > 0) {
          const downloader = options.triggerDownload ?? defaultTriggerDownload;
          try {
            downloader(blob, filename);
            resolve(filename);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : 'Falha ao iniciar download do vídeo.';
            options.onError?.(msg);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      };

      recorder.onstop = finalize;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        } else {
          finalize();
        }
      } catch {
        finalize();
      }
    });

    return stopPromise;
  }

  function dispose(): void {
    recording = false;
    cancelRenderLoop();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.onstop = null;
        mediaRecorder.stop();
      } catch {
        // Ignore teardown errors
      }
    }
    mediaRecorder = null;
    stopStreamTracks();
    chunks = [];
    compositorCanvas = null;
    compositorCtx = null;
  }

  return {
    start,
    stopAndDownload,
    isRecording: () => recording,
    dispose,
  };
}
