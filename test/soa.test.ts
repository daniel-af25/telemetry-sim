/**
 * Issue #11 — Fase 2.2: Empacotamento SoA Zero-Copy (src/core/soa.ts)
 * Destino em telemetry-sim: test/soa.test.ts
 *
 * Contrato travado por este teste:
 *   - TRACK_FLAG: { GPS_VALID: 1, IS_GAP: 2, IS_TUNNEL_DR: 4, IS_SLIP: 8 }
 *   - packToSoA(frames: readonly ProcessedFrameInput[]): TelemetryTrackSoA
 *       Float64Array: t, lat, lon, x, y
 *       Float32Array: speedMs, ax, ay, az, omegaZ, yaw, steerRad, rollRad, pitchRad,
 *                     fzFL, fzFR, fzRL, fzRR, kammIndex, roadGradePct, distM
 *       Uint8Array: flags
 *   - getTransferables(track: TelemetryTrackSoA): ArrayBuffer[]
 */
import { describe, expect, it } from 'vitest';
import { getTransferables, packToSoA, TRACK_FLAG } from '../src/core/soa.ts';

describe('soa — TelemetryTrackSoA & zero-copy transferables', () => {
  it('empacota corretamente todos os canais em TypedArrays contíguos e preserva flags bitmask', () => {
    const soa = packToSoA([
      {
        t: 0.0,
        lat: 41.172,
        lon: -8.5485,
        x: 0,
        y: 0,
        speedMs: 10.5,
        ax: -2.0,
        ay: 1.5,
        az: 9.81,
        omegaZ: 0.12,
        yaw: 0.5,
        steerRad: 0.08,
        rollRad: 0.02,
        pitchRad: 0.01,
        fzFL: 4000,
        fzFR: 4500,
        fzRL: 3000,
        fzRR: 3200,
        kammIndex: 0.45,
        roadGradePct: 1.5,
        distM: 0,
        gpsValid: true,
        isGap: false,
        isTunnelDr: false,
        isSlip: false,
      },
      {
        t: 1.8,
        lat: 41.1721,
        lon: -8.5484,
        x: 12.4,
        y: 11.1,
        speedMs: 12.0,
        ax: 0,
        ay: 3.8,
        az: 9.81,
        omegaZ: -0.3,
        yaw: 0.55,
        steerRad: -0.05,
        rollRad: 0.04,
        pitchRad: 0,
        fzFL: 3800,
        fzFR: 4700,
        fzRL: 2800,
        fzRR: 3400,
        kammIndex: 0.92,
        roadGradePct: -0.5,
        distM: 16.6,
        gpsValid: false,
        isGap: true,
        isTunnelDr: true,
        isSlip: true,
      },
    ]);

    expect(soa.length).toBe(2);
    expect(soa.t).toBeInstanceOf(Float64Array);
    expect(soa.lat).toBeInstanceOf(Float64Array);
    expect(soa.x).toBeInstanceOf(Float64Array);
    expect(soa.speedMs).toBeInstanceOf(Float32Array);
    expect(soa.fzFL).toBeInstanceOf(Float32Array);
    expect(soa.flags).toBeInstanceOf(Uint8Array);

    expect(soa.lat[0]).toBeCloseTo(41.172, 7);
    expect(soa.fzFR[1]).toBeCloseTo(4700, 1);

    // Bitmask sample 0: apenas GPS_VALID
    expect(soa.flags[0]).toBe(TRACK_FLAG.GPS_VALID);
    // Bitmask sample 1: IS_GAP | IS_TUNNEL_DR | IS_SLIP (sem GPS_VALID)
    expect(soa.flags[1]).toBe(
      TRACK_FLAG.IS_GAP | TRACK_FLAG.IS_TUNNEL_DR | TRACK_FLAG.IS_SLIP,
    );
  });

  it('devolve lista de ArrayBuffers únicos e não vazios para postMessage zero-copy', () => {
    const soa = packToSoA([
      {
        t: 0,
        lat: 41.17,
        lon: -8.55,
        x: 0,
        y: 0,
        speedMs: 0,
        ax: 0,
        ay: 0,
        az: 9.81,
        omegaZ: 0,
        yaw: 0,
        steerRad: 0,
        rollRad: 0,
        pitchRad: 0,
        fzFL: 3500,
        fzFR: 3500,
        fzRL: 3500,
        fzRR: 3500,
        kammIndex: 0,
        roadGradePct: 0,
        distM: 0,
        gpsValid: true,
        isGap: false,
        isTunnelDr: false,
        isSlip: false,
      },
    ]);

    const transferables = getTransferables(soa);
    expect(transferables.length).toBeGreaterThanOrEqual(20);
    // Sem referências duplicadas (evita DataCloneError no postMessage)
    expect(new Set(transferables).size).toBe(transferables.length);
    for (const buf of transferables) {
      expect(buf).toBeInstanceOf(ArrayBuffer);
    }
  });
});
