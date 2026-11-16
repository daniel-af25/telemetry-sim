import { TelemetryPointRaw } from '../../src/core/types';

export function makeSyntheticTrip(): TelemetryPointRaw[] {
  const points: TelemetryPointRaw[] = [];
  // 100 amostras a 5 Hz (dt = 0.20 s)
  for (let i = 0; i < 100; i++) {
    const t = i * 0.20;
    points.push({
      timestamp: t,
      lat: 41.1500 + i * 0.0001,
      lon: -8.6100 + i * 0.0001,
      speed: i < 20 ? i * 2.5 : 50.0,
      accelX: i >= 30 && i < 50 ? -0.4 : 0.0, // curva à esquerda
      accelY: i >= 60 && i < 75 ? -0.8 : 0.1, // travagem
      accelZ: 1.0,
      gyroZ: i >= 30 && i < 50 ? 12.0 : 0.0,
    });
  }
  return points;    
}