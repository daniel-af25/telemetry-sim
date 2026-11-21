/**
 * Orquestrador do Lab Dinâmico ao Vivo 2D/3D (`src/ui/labOverlay.ts`):
 * - Monta `.lab-overlay` entre `.top-bar` (`z-index: 20`) e `.timeline-dock` (`z-index: 20`),
 *   mantendo controlos superiores e timeline sempre acessíveis.
 * - Comuta instantaneamente entre `topDownLab` (`is3D === false`) e `view3dLab` (`is3D === true`)
 *   sempre que `state.is3D` muda, preservando o instante `t` e a reprodução a 60 FPS.
 * - Controlos contextuais no cabeçalho interno (2D: Seguir/Trajeto + 10/14/22 m;
 *   3D: Isométrico/Perspetiva, Chase, Reset Câmara, Exagero 1×/4×) + atalhos `Esc`, `C`, `P`.
 * - Zero custo de CPU/GPU quando fechado (`!isOpen`).
 */
import type { SampleFrame } from '../core/interpolator.ts';
import type { TelemetryTrackSoA } from '../core/soa.ts';
import type { KammLimits } from '../core/types.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';
import { computeLabRunScales } from './labTelemetryMath.ts';
import {
  createTopDownLab,
  type TopDownLabController,
  type TopDownWindowSizeM,
} from './topDownLab.ts';
import { createView3dLab, type View3dLabController } from './view3dLab.ts';

const WINDOW_SIZES_M: readonly TopDownWindowSizeM[] = [10, 14, 22] as const;

export interface LabOverlaySessionData {
  sessionLabel: string;
  vehicleSpecs: ResolvedVehicleSpecs;
  kammLimits: KammLimits;
  track: TelemetryTrackSoA;
}

export interface LabOverlayOptions {
  container: HTMLElement;
  initial3D?: boolean;
  initialExaggerate?: number;
  onClose: () => void;
  onSeek: (tSec: number) => void;
  onExaggerateChange: (exaggerate: number) => void;
}

export interface LabOverlayController {
  setOpen(open: boolean): void;
  isOpen(): boolean;
  setMode3D(is3D: boolean): void;
  setExaggerate(exaggerate: number): void;
  setSessionData(data: LabOverlaySessionData): void;
  updateFrame(tSec: number, frame: SampleFrame | null, dtSec: number): void;
  dispose(): void;
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Creates the full-viewport engineering Lab overlay hosting both `topDownLab` (2D)
 * and `view3dLab` (3D Isometric/Perspective) synced to the master `PlaybackClock`.
 */
export function createLabOverlay(options: LabOverlayOptions): LabOverlayController {
  let open = false;
  let is3D = options.initial3D ?? true;
  let exaggerate = options.initialExaggerate ?? 4.0;
  let lastTimeSec = 0;
  let lastFrame: SampleFrame | null = null;

  const overlay = el('section', 'lab-overlay glass-panel is-hidden');
  overlay.setAttribute('aria-label', 'Lab Dinâmico de Engenharia 2D/3D');

  // -------------------------------------------------------------------------
  // Thin Contextual Header Bar
  // -------------------------------------------------------------------------
  const header = el('div', 'lab-header');
  const titleGroup = el('div', 'lab-header__left');
  const modeBadge = el('span', 'lab-mode-badge', 'LAB 3D • ISOMÉTRICO');
  const sessionTitleEl = el('span', 'lab-header__session', 'Sem sessão carregada');
  titleGroup.append(modeBadge, sessionTitleEl);

  const controlsGroup = el('div', 'lab-header__controls');

  // 2D Top-Down contextual controls
  const controls2D = el('div', 'lab-ctx-group');
  const followGroup = el('div', 'segmented-group');
  const followBtn = el('button', 'seg-btn is-active', 'Seguir');
  followBtn.type = 'button';
  const wholeTrackBtn = el('button', 'seg-btn', 'Trajeto completo');
  wholeTrackBtn.type = 'button';
  followGroup.append(followBtn, wholeTrackBtn);

  const winGroup = el('div', 'segmented-group');
  const winButtons = new Map<TopDownWindowSizeM, HTMLButtonElement>();
  for (const sizeM of WINDOW_SIZES_M) {
    const btn = el('button', 'seg-btn tabular-nums', `${sizeM} m`);
    btn.type = 'button';
    if (sizeM === 14) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      topDownLab.setWindowSizeM(sizeM);
      sync2DControls();
    });
    winButtons.set(sizeM, btn);
    winGroup.append(btn);
  }
  controls2D.append(followGroup, winGroup);

  // 3D Isometric contextual controls
  const controls3D = el('div', 'lab-ctx-group');
  const projGroup = el('div', 'segmented-group');
  const isoBtn = el('button', 'seg-btn is-active', 'Isométrico');
  isoBtn.type = 'button';
  isoBtn.title = 'Projeção ortográfica isométrica verdadeira (P)';
  const perspBtn = el('button', 'seg-btn', 'Perspetiva');
  perspBtn.type = 'button';
  perspBtn.title = 'Câmara em perspetiva (P)';
  projGroup.append(isoBtn, perspBtn);

  const chase3DBtn = el('button', 'icon-btn lab-ctx-btn', 'Chase');
  chase3DBtn.type = 'button';
  chase3DBtn.title = 'Bloquear câmara atrás do veículo (C)';

  const resetCamBtn = el('button', 'icon-btn lab-ctx-btn', 'Reset Câmara');
  resetCamBtn.type = 'button';

  const exagGroup = el('div', 'segmented-group');
  const exag1Btn = el('button', 'seg-btn tabular-nums', '1×');
  exag1Btn.type = 'button';
  exag1Btn.title = 'Inclinação da carroceria à escala real (1×)';
  const exag4Btn = el('button', 'seg-btn tabular-nums', '4×');
  exag4Btn.type = 'button';
  exag4Btn.title = 'Inclinação da carroceria exagerada (4× como view3d.py)';
  exagGroup.append(exag1Btn, exag4Btn);

  controls3D.append(projGroup, chase3DBtn, resetCamBtn, exagGroup);

  const closeBtn = el('button', 'icon-btn lab-close-btn', '✕ Fechar');
  closeBtn.type = 'button';
  closeBtn.title = 'Fechar Lab 2D/3D (Esc)';
  closeBtn.addEventListener('click', () => options.onClose());

  controlsGroup.append(controls2D, controls3D, closeBtn);
  header.append(titleGroup, controlsGroup);

  const body = el('div', 'lab-overlay__body');
  overlay.append(header, body);
  options.container.append(overlay);

  // -------------------------------------------------------------------------
  // Child Labs (2D Canvas Top-Down & 3D Three.js Isometric)
  // -------------------------------------------------------------------------
  const topDownLab: TopDownLabController = createTopDownLab({
    container: body,
    onSeek: (tSec) => options.onSeek(tSec),
  });

  const view3dLab: View3dLabController = createView3dLab({
    container: body,
    initialExaggerate: exaggerate,
    onCameraStateChange: () => sync3DControls(),
  });

  function sync2DControls(): void {
    const isFollow = topDownLab.getFollow();
    followBtn.classList.toggle('is-active', isFollow);
    wholeTrackBtn.classList.toggle('is-active', !isFollow);
    const activeWin = topDownLab.getWindowSizeM();
    for (const [sz, btn] of winButtons.entries()) {
      btn.classList.toggle('is-active', sz === activeWin);
      btn.disabled = !isFollow;
    }
  }

  function sync3DControls(): void {
    const isIso = view3dLab.isIsometric();
    isoBtn.classList.toggle('is-active', isIso);
    perspBtn.classList.toggle('is-active', !isIso);
    chase3DBtn.classList.toggle('is-active', view3dLab.isChase());
    exag1Btn.classList.toggle('is-active', Math.abs(exaggerate - 1) < 0.05);
    exag4Btn.classList.toggle('is-active', Math.abs(exaggerate - 4) < 0.05);
  }

  function syncActiveView(): void {
    modeBadge.textContent = is3D ? 'LAB 3D • ISOMÉTRICO' : 'LAB 2D • TOP-DOWN';
    controls2D.classList.toggle('is-hidden', is3D);
    controls3D.classList.toggle('is-hidden', !is3D);
    topDownLab.element.classList.toggle('is-hidden', is3D);
    view3dLab.element.classList.toggle('is-hidden', !is3D);
    sync2DControls();
    sync3DControls();

    if (open) {
      if (is3D) {
        view3dLab.resize();
        view3dLab.updateFrame(lastTimeSec, lastFrame, 0);
      } else {
        topDownLab.resize();
        topDownLab.updateFrame(lastTimeSec, lastFrame);
      }
    }
  }

  followBtn.addEventListener('click', () => {
    topDownLab.setFollow(true);
    sync2DControls();
  });
  wholeTrackBtn.addEventListener('click', () => {
    topDownLab.setFollow(false);
    sync2DControls();
  });

  isoBtn.addEventListener('click', () => view3dLab.setIsometric(true));
  perspBtn.addEventListener('click', () => view3dLab.setIsometric(false));
  chase3DBtn.addEventListener('click', () => view3dLab.setChase(!view3dLab.isChase()));
  resetCamBtn.addEventListener('click', () => view3dLab.resetCamera());
  exag1Btn.addEventListener('click', () => options.onExaggerateChange(1.0));
  exag4Btn.addEventListener('click', () => options.onExaggerateChange(4.0));

  // Keyboard shortcuts when overlay is open: Escape closes; C & P control 3D camera
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || isEditableTarget(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      options.onClose();
      return;
    }
    if (!is3D) return;
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      view3dLab.setChase(!view3dLab.isChase());
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      view3dLab.setIsometric(!view3dLab.isIsometric());
    }
  };
  window.addEventListener('keydown', onKeyDown);

  syncActiveView();

  function setOpen(nextOpen: boolean): void {
    open = nextOpen;
    overlay.classList.toggle('is-hidden', !open);
    if (open) {
      syncActiveView();
    }
  }

  function setMode3D(next3D: boolean): void {
    is3D = next3D;
    syncActiveView();
  }

  function setExaggerate(nextExag: number): void {
    exaggerate = nextExag;
    view3dLab.setExaggerate(nextExag);
    sync3DControls();
  }

  function setSessionData(data: LabOverlaySessionData): void {
    const scales = computeLabRunScales(data.track, data.vehicleSpecs);
    sessionTitleEl.textContent = `${data.sessionLabel} · ${data.vehicleSpecs.name}`;

    topDownLab.setSessionData({
      sessionLabel: data.sessionLabel,
      vehicleSpecs: data.vehicleSpecs,
      kammLimits: data.kammLimits,
      track: data.track,
      scales,
    });
    view3dLab.setSessionData({
      sessionLabel: data.sessionLabel,
      vehicleSpecs: data.vehicleSpecs,
      kammLimits: data.kammLimits,
      track: data.track,
      scales,
    });
  }

  function updateFrame(tSec: number, frame: SampleFrame | null, dtSec: number): void {
    lastTimeSec = tSec;
    lastFrame = frame;
    if (!open) return;

    if (is3D) {
      view3dLab.updateFrame(tSec, frame, dtSec);
    } else {
      topDownLab.updateFrame(tSec, frame);
    }
  }

  function dispose(): void {
    window.removeEventListener('keydown', onKeyDown);
    topDownLab.dispose();
    view3dLab.dispose();
    overlay.remove();
  }

  return {
    setOpen,
    isOpen: () => open,
    setMode3D,
    setExaggerate,
    setSessionData,
    updateFrame,
    dispose,
  };
}
