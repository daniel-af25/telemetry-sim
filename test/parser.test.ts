import { test } from 'node:test';
import assert from 'node:assert';
import { parseCsv } from '../src/core/parser.ts';

test('Parser: Deteção de escala mili-G por sessão (regra max > 15)', () => {
  const csvMilli = `# trip_mode=road
timestamp,lat,lon,speed,accelX,accelY,accelZ,gyroZ
0.0,41.15,-8.61,40.0,150,16500,980,1.2`;

  const res = parseCsv(csvMilli);
  assert.strictEqual(res.scalingFactor, 1000);
});

test('Parser: Auto-descoberta de canais extras dinâmicos', () => {
  const csv = `timestamp,lat,lon,speed,accelX,accelY,accelZ,gyroZ,boost_bar,brake_temp
0.0,41.15,-8.61,40.0,0.1,0.2,1.0,0.0,1.4,320`;

  const res = parseCsv(csv);
  assert.deepStrictEqual(res.extraChannels, ['boost_bar', 'brake_temp']);
  assert.strictEqual(res.data[0].extras?.['boost_bar'], 1.4);
});