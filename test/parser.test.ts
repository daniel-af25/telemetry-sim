import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/core/parser.ts';

describe('parseCsv', () => {
  it('Parser: Deteção de escala mili-G por sessão (regra max > 15)', () => {
    const csvMilli = `# trip_mode=road
timestamp,lat,lon,speed,accelX,accelY,accelZ,gyroZ
0.0,41.15,-8.61,40.0,150,16500,980,1.2`;

    const res = parseCsv(csvMilli);
    expect(res.scalingFactor).toBe(1000);
  });

  it('Parser: Auto-descoberta de canais extras dinâmicos', () => {
    const csv = `timestamp,lat,lon,speed,accelX,accelY,accelZ,gyroZ,boost_bar,brake_temp
0.0,41.15,-8.61,40.0,0.1,0.2,1.0,0.0,1.4,320`;

    const res = parseCsv(csv);
    expect(res.extraChannels).toEqual(['boost_bar', 'brake_temp']);
    expect(res.data[0]?.extras?.['boost_bar']).toBe(1.4);
  });
});
