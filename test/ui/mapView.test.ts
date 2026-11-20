/**
 * Issue #13 — Fase 3.3: Telemetry Ribbon GeoJSON (src/ui/mapView.ts)
 * Valida quantização RdYlGn_r, fusão de segmentos contíguos, separação de túneis
 * (`TRACK_FLAG.IS_TUNNEL_DR`), quebras `TRACK_FLAG.IS_GAP` e cálculo de `bounds`.
 */
import { describe, expect, it } from 'vitest';
import { packToSoA, type ProcessedFrameInput } from '../../src/core/soa.ts';
import {
  buildTelemetryRibbonGeoJson,
  RDYLGN_R_PALETTE,
} from '../../src/ui/mapView.ts';

function makeSoA(
  entries: Array<Partial<ProcessedFrameInput> & { t: number; lat: number; lon: number }>,
) {
  return packToSoA(
    entries.map((e, idx) => ({
      x: idx * 2,
      y: 0,
      speedMs: 12,
      ax: 0,
      ay: 0,
      az: 9.81,
      omegaZ: 0,
      yaw: 0,
      steerRad: 0,
      rollRad: 0,
      pitchRad: 0,
      fzFL: 3600,
      fzFR: 3600,
      fzRL: 3600,
      fzRR: 3600,
      kammIndex: 0.1,
      roadGradePct: 0,
      distM: idx * 2,
      gpsValid: true,
      isGap: false,
      isTunnelDr: false,
      isSlip: false,
      ...e,
    })),
  );
}

describe('mapView — buildTelemetryRibbonGeoJson (RdYlGn_r & IS_TUNNEL_DR)', () => {
  it('quantiza segmentos em RdYlGn_r (verde -> vermelho) e funde segmentos adjacentes no mesmo escalão', () => {
    const soa = makeSoA([
      // 3 pontos seguidos em regime baixo (bin 0 => verde)
      { t: 0.0, lat: 41.15, lon: -8.61, kammIndex: 0.02 },
      { t: 0.2, lat: 41.1501, lon: -8.61, kammIndex: 0.02 },
      { t: 0.4, lat: 41.1502, lon: -8.61, kammIndex: 0.02 },
      // Pico severo (kammIndex >= 1.2 => último bin vermelho)
      { t: 0.6, lat: 41.1503, lon: -8.61, kammIndex: 1.25 },
    ]);

    const res = buildTelemetryRibbonGeoJson(soa, 'kammIndex');
    expect(res.tunnels.features).toHaveLength(0);
    // 2 segmentos baixos fundidos numa única LineString (3 vértices) + 1 segmento de pico (2 vértices)
    expect(res.ribbon.features).toHaveLength(2);

    const lowSeg = res.ribbon.features[0];
    const peakSeg = res.ribbon.features[1];
    expect(lowSeg?.geometry.coordinates).toHaveLength(3);
    expect(lowSeg?.properties.bin).toBe(0);
    expect(lowSeg?.properties.color).toBe(RDYLGN_R_PALETTE[0]);

    expect(peakSeg?.properties.bin).toBe(RDYLGN_R_PALETTE.length - 1);
    expect(peakSeg?.properties.color).toBe(RDYLGN_R_PALETTE[RDYLGN_R_PALETTE.length - 1]);
    expect(peakSeg?.properties.value).toBeCloseTo(1.25, 2);

    expect(res.bounds).not.toBeNull();
    expect(res.bounds?.[0]).toEqual([-8.61, 41.15]);
    expect(res.bounds?.[1]).toEqual([-8.61, 41.1503]);
  });

  it('separa segmentos com IS_TUNNEL_DR para a camada tunnels e respeita quebras IS_GAP', () => {
    const soa = makeSoA([
      // Superfície antes do túnel
      { t: 0.0, lat: 41.16, lon: -8.62, speedMs: 10, isTunnelDr: false },
      { t: 0.2, lat: 41.1601, lon: -8.62, speedMs: 10, isTunnelDr: false },
      // Trecho em túnel (dead-reckoning)
      { t: 0.4, lat: 41.1602, lon: -8.62, speedMs: 10, isTunnelDr: true, gpsValid: false },
      { t: 0.6, lat: 41.1603, lon: -8.62, speedMs: 10, isTunnelDr: true, gpsValid: false },
      // Saída do túnel
      { t: 0.8, lat: 41.1604, lon: -8.62, speedMs: 10, isTunnelDr: false },
      // Lacuna temporal > 1.0 s (não deve ligar ao ponto anterior)
      { t: 5.0, lat: 41.17, lon: -8.63, speedMs: 30, isGap: true, isTunnelDr: false },
      { t: 5.2, lat: 41.1701, lon: -8.63, speedMs: 30, isGap: false, isTunnelDr: false },
    ]);

    const res = buildTelemetryRibbonGeoJson(soa, 'speed');

    // Túnel tem os segmentos contíguos que tocam amostras IS_TUNNEL_DR
    expect(res.tunnels.features).toHaveLength(1);
    expect(res.tunnels.features[0]?.properties.isTunnel).toBe(true);
    expect(res.tunnels.features[0]?.geometry.coordinates.length).toBeGreaterThanOrEqual(3);

    // Superfície tem 2 segmentos separados (antes do túnel e depois da lacuna IS_GAP)
    expect(res.ribbon.features).toHaveLength(2);
    // Velocidade pós-lacuna (30 m/s = 108 km/h) tem bin superior à pré-túnel (36 km/h)
    const preBin = res.ribbon.features[0]?.properties.bin ?? -1;
    const postBin = res.ribbon.features[1]?.properties.bin ?? -1;
    expect(postBin).toBeGreaterThan(preBin);
  });

  it('suporta todas as métricas do RibbonMetric sem NaN e ignora coordenadas (0, 0)', () => {
    const soa = makeSoA([
      { t: 0.0, lat: 0, lon: 0, gpsValid: false },
      { t: 0.2, lat: 41.15, lon: -8.61, ax: -4.9, ay: 3.9, roadGradePct: 6.5 },
      { t: 0.4, lat: 41.1502, lon: -8.6102, ax: -5.0, ay: 4.0, roadGradePct: 7.0 },
    ]);

    for (const metric of ['kammIndex', 'speed', 'ay', 'ax', 'roadGradePct'] as const) {
      const res = buildTelemetryRibbonGeoJson(soa, metric);
      expect(res.ribbon.features).toHaveLength(1);
      expect(res.bounds?.[0]).toEqual([-8.6102, 41.15]);
      expect(res.bounds?.[1]).toEqual([-8.61, 41.1502]);
    }
  });
});
