/**
 * Testes unitários do gravador de vídeo nativo (`src/ui/videoRecorder.ts`):
 * seleção de MIME WebM (vp9 -> vp8 -> webm), sanitização de nomes de ficheiro
 * e ciclo completo start() -> stopAndDownload() com mocks leves em Node.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildVideoFilename,
  createTripVideoRecorder,
  selectSupportedVideoMimeType,
  type MediaRecorderLike,
  type VideoOverlaySnapshot,
} from '../../src/ui/videoRecorder.ts';

function makeOverlay(is3D: boolean): VideoOverlaySnapshot {
  return {
    sessionLabel: 'TRIP_20261117_172131',
    vehicleName: 'AUDI A3 Sportback 40 TFSI e',
    is3D,
    speedKmh: 54.2,
    kammIndex: 0.42,
    latG: 0.18,
    lonG: -0.12,
    roadGradePct: 2.1,
    timeSec: 12.4,
    durationSec: 120.0,
  };
}

describe('videoRecorder — MIME selection & filename sanitization', () => {
  it('prefere vp9 -> vp8 -> video/webm e devolve null quando nenhum é suportado', () => {
    expect(
      selectSupportedVideoMimeType((m) => m === 'video/webm;codecs=vp9' || m === 'video/webm'),
    ).toBe('video/webm;codecs=vp9');

    expect(selectSupportedVideoMimeType((m) => m === 'video/webm;codecs=vp8')).toBe(
      'video/webm;codecs=vp8',
    );

    expect(selectSupportedVideoMimeType((m) => m === 'video/webm')).toBe('video/webm');
    expect(selectSupportedVideoMimeType(() => false)).toBeNull();
  });

  it('sanitiza o nome da sessão e aplica sufixo _3d.webm ou _2d.webm', () => {
    expect(buildVideoFilename('TRIP_20261117_172131', true)).toBe(
      'telemetry_TRIP_20261117_172131_3d.webm',
    );
    expect(buildVideoFilename('Porto / São João <script>', false)).toBe(
      'telemetry_Porto_Sao_Joao_script_2d.webm',
    );
    expect(buildVideoFilename('   ', true)).toBe('telemetry_trip_3d.webm');
    expect(buildVideoFilename(null, false)).toBe('telemetry_trip_2d.webm');
  });
});

describe('videoRecorder — start/stop lifecycle with mock MediaRecorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('executa start -> stopAndDownload, notifica onStateChange e dispara download com Blob', async () => {
    const fakeCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const fakeTrackStop = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: fakeTrackStop }],
    } as unknown as MediaStream;

    const fakeCanvas = {
      width: 1280,
      height: 720,
      clientWidth: 1280,
      clientHeight: 720,
      getContext: () => fakeCtx,
      captureStream: vi.fn(() => fakeStream),
    } as unknown as HTMLCanvasElement;

    vi.stubGlobal('document', {
      createElement: () => fakeCanvas,
    });

    const onStateChange = vi.fn();
    const triggerDownload = vi.fn();

    let mockRecorderRef: MediaRecorderLike | null = null;
    const createMediaRecorder = vi.fn((_stream: MediaStream, _opts: MediaRecorderOptions) => {
      const rec: MediaRecorderLike = {
        state: 'inactive',
        ondataavailable: null,
        onstop: null,
        onerror: null,
        start() {
          (this as { state: string }).state = 'recording';
          this.ondataavailable?.({ data: new Blob(['webm-chunk'], { type: 'video/webm' }) });
        },
        stop() {
          (this as { state: string }).state = 'inactive';
          this.onstop?.();
        },
      };
      mockRecorderRef = rec;
      return rec;
    });

    const recorder = createTripVideoRecorder({
      getSourceCanvas: () => fakeCanvas,
      getOverlayData: () => makeOverlay(true),
      onStateChange,
      isTypeSupported: (m) => m === 'video/webm;codecs=vp9',
      createMediaRecorder,
      triggerDownload,
    });

    expect(recorder.start()).toBe(true);
    expect(recorder.isRecording()).toBe(true);
    expect(mockRecorderRef).not.toBeNull();
    expect(onStateChange).toHaveBeenCalledWith(true, 0);

    const filename = await recorder.stopAndDownload();
    expect(filename).toBe('telemetry_TRIP_20261117_172131_3d.webm');
    expect(recorder.isRecording()).toBe(false);
    expect(fakeTrackStop).toHaveBeenCalledTimes(1);
    expect(triggerDownload).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenLastCalledWith(false, expect.any(Number));
  });

  it('reporta erro limpo via onError quando MediaRecorder não é suportado', () => {
    const onError = vi.fn();
    const recorder = createTripVideoRecorder({
      getSourceCanvas: () => ({ width: 800, height: 600 }) as HTMLCanvasElement,
      getOverlayData: () => makeOverlay(false),
      isTypeSupported: () => false,
      onError,
    });

    expect(recorder.start()).toBe(false);
    expect(recorder.isRecording()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
