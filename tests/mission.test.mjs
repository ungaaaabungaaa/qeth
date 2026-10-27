import test from 'node:test';
import assert from 'node:assert/strict';
import { planMission } from '../src/mission.ts';

const rectangle = {
  type: 'Polygon',
  coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]
};

test('plans an open survey route with measured distance and explicit battery assumptions', () => {
  const plan = planMission(rectangle, { spacingM: 40, speedMps: 4, batteryMinutes: 20, reservePercent: 25 });
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.kind, 'mission-plan');
  assert.ok(plan.waypoints.length >= 6);
  assert.ok(plan.distanceM > 300 && plan.distanceM < 500);
  assert.equal(plan.estimatedSeconds, plan.distanceM / 4);
  assert.equal(plan.usableBatterySeconds, 900);
  assert.equal(plan.estimatedBatteryPercent, plan.estimatedSeconds / 1200 * 100);
  assert.equal(plan.withinBatteryBudget, true);
  assert.notDeepEqual(plan.waypoints[0], plan.waypoints.at(-1));
  assert.equal(plan.geojson.features[1].geometry.type, 'LineString');
  assert.equal(plan.geojson.features[1].geometry.coordinates.length, plan.waypoints.length);
  assert.ok(plan.warnings.some(w => /wind/i.test(w)));
});

test('accepts Polygon Features and single-feature collections without mutating input', () => {
  const input = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: structuredClone(rectangle) }] };
  const before = JSON.stringify(input);
  assert.equal(planMission(input).kind, 'mission-plan');
  assert.equal(JSON.stringify(input), before);
});

test('rejects malformed, open, repeated, degenerate, and crossing rings as input errors', () => {
  const cases = [
    null,
    { type: 'Point', coordinates: [0, 0] },
    { type: 'FeatureCollection', features: [] },
    { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: rectangle }, { type: 'Feature', geometry: rectangle }] },
    { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.002, 0], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0.001], [0, 0.001], [0.001, 0], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, NaN], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [181, 0], [0.001, 0.001], [0, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0, 2], [0.001, 0.001], [0, 0]]] }
  ];
  for (const input of cases) assert.throws(() => planMission(input), { name: 'QethError', exitCode: 2 });
});

test('rejects polar, antimeridian, long narrow, and diagonal extents outside the projection range', () => {
  for (const ring of [
    [[0, 81], [0.001, 81], [0.001, 81.001], [0, 81]],
    [[179.999, 0], [-179.999, 0], [-179.999, 0.001], [179.999, 0]],
    [[0, 0], [0.001, 0], [0.001, 0.2], [0, 0.2], [0, 0]],
    [[0, 0], [0.15, 0], [0.15, 0.15], [0, 0.15], [0, 0]]
  ]) assert.throws(() => planMission({ type: 'Polygon', coordinates: [ring] }), { name: 'QethError' });
});

test('rejects every explicit nonfinite or out-of-range mission option', () => {
  for (const options of [
    { spacingM: 0 }, { spacingM: NaN }, { spacingM: null }, { spacingM: 1001 },
    { speedMps: 0 }, { speedMps: Infinity }, { altitudeM: 0 }, { altitudeM: 501 },
    { batteryMinutes: 0 }, { batteryMinutes: 1441 }, { reservePercent: -1 }, { reservePercent: 91 },
    { optimize: 'unknown' }, { speedMps: '5' }
  ]) assert.throws(() => planMission(rectangle, options), { name: 'QethError', exitCode: 2 });
});

// Clip a segment against an open rectangle. This tests the entire connector,
// including intervals between waypoints, rather than sampling a few points.
function crossesOpenBox(a, b, [x0, y0, x1, y1]) {
  let low = 0, high = 1;
  for (const [axis, min, max] of [[0, x0, x1], [1, y0, y1]]) {
    const start = a[axis], delta = b[axis] - start;
    if (Math.abs(delta) < 1e-15) {
      if (start <= min + 1e-12 || start >= max - 1e-12) return false;
    } else {
      const p = (min - start) / delta, q = (max - start) / delta;
      low = Math.max(low, Math.min(p, q));
      high = Math.min(high, Math.max(p, q));
    }
  }
  return high - low > 1e-9;
}

function assertAvoidsBox(plan, box) {
  const points = plan.waypoints.map(p => [p.lon, p.lat]);
  for (let i = 1; i < points.length; i++) {
    assert.equal(crossesOpenBox(points[i - 1], points[i], box), false,
      `segment ${i - 1} -> ${i} crosses the excluded rectangle`);
  }
}

test('clips survey legs around a hole and finds feasible connectors for the entire route', () => {
  const hole = [[0.00035, 0.0003], [0.00065, 0.0003], [0.00065, 0.0007], [0.00035, 0.0007], [0.00035, 0.0003]];
  const input = { type: 'Polygon', coordinates: [rectangle.coordinates[0], hole] };
  const plan = planMission(input, { spacingM: 10 });
  assert.ok(plan.waypoints.length > 20);
  assertAvoidsBox(plan, [0.00035, 0.0003, 0.00065, 0.0007]);
  for (const p of plan.waypoints) assert.ok(p.lon >= -1e-12 && p.lon <= 0.001 + 1e-12 && p.lat >= -1e-12 && p.lat <= 0.001 + 1e-12);
});

test('keeps every segment inside a concave L boundary', () => {
  const input = { type: 'Polygon', coordinates: [[[0, 0], [0.002, 0], [0.002, 0.0008], [0.0008, 0.0008], [0.0008, 0.002], [0, 0.002], [0, 0]]] };
  const plan = planMission(input, { spacingM: 15 });
  assertAvoidsBox(plan, [0.0008, 0.0008, 0.0021, 0.0021]);
  for (const p of plan.waypoints) assert.ok(p.lon <= 0.0008 + 1e-12 || p.lat <= 0.0008 + 1e-12);
});

test('rejects holes that cross, touch, overlap, or lie outside another boundary', () => {
  const outer = rectangle.coordinates[0];
  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  for (const holes of [
    [box(0, 0.0001, 0.0003, 0.0003)],
    [box(0.0008, 0.0008, 0.0012, 0.0012)],
    [box(0.002, 0.002, 0.003, 0.003)],
    [box(0.0001, 0.0001, 0.0005, 0.0005), box(0.0004, 0.0004, 0.0008, 0.0008)],
    [box(0.0001, 0.0001, 0.0008, 0.0008), box(0.0002, 0.0002, 0.0003, 0.0003)],
    [box(0.0001, 0.0001, 0.0004, 0.0004), box(0.0004, 0.0001, 0.0008, 0.0004)]
  ]) assert.throws(() => planMission({ type: 'Polygon', coordinates: [outer, ...holes] }), { name: 'QethError', exitCode: 2 });
});

test('plans around multiple holes in either ring orientation', () => {
  const a = [[0.00015, 0.0002], [0.0003, 0.0002], [0.0003, 0.0007], [0.00015, 0.0007], [0.00015, 0.0002]];
  const b = [[0.0006, 0.0001], [0.0008, 0.0001], [0.0008, 0.0008], [0.0006, 0.0008], [0.0006, 0.0001]];
  const input = { type: 'Polygon', coordinates: [rectangle.coordinates[0], a, b] };
  const first = planMission(input, { spacingM: 12, optimize: 'distance' });
  const reversed = planMission({ type: 'Polygon', coordinates: input.coordinates.map(r => r.toReversed()) }, { spacingM: 12, optimize: 'battery' });
  for (const plan of [first, reversed]) {
    assertAvoidsBox(plan, [0.00015, 0.0002, 0.0003, 0.0007]);
    assertAvoidsBox(plan, [0.0006, 0.0001, 0.0008, 0.0008]);
  }
  assert.ok(Math.abs(first.distanceM - reversed.distanceM) < 1e-5);
});

test('connects separated survey intervals through a concave U without crossing its opening', () => {
  const input = { type: 'Polygon', coordinates: [[[0, 0], [0.002, 0], [0.002, 0.002], [0.0013, 0.002], [0.0013, 0.0005], [0.0007, 0.0005], [0.0007, 0.002], [0, 0.002], [0, 0]]] };
  const plan = planMission(input, { spacingM: 15 });
  assertAvoidsBox(plan, [0.0007, 0.0005, 0.0013, 0.003]);
  assert.ok(plan.legs.some(leg => leg.kind === 'transit'));
});

test('bounds row allocation and still accepts a narrow route in the other orientation', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]]] };
  assert.throws(() => planMission(square, { spacingM: 1 }), /1000-leg/);
  const narrow = { type: 'Polygon', coordinates: [[[0, 0], [0.02, 0], [0.02, 0.000005], [0, 0.000005], [0, 0]]] };
  const plan = planMission(narrow, { spacingM: 1, batteryMinutes: 1, speedMps: 1, reservePercent: 0 });
  assert.equal(plan.waypoints.length, 2);
  assert.equal(plan.withinBatteryBudget, false);
  assert.ok(plan.estimatedBatteryPercent > 100);
});

test('rejects excessive input vertices before route allocation', () => {
  const ring = Array.from({ length: 1001 }, (_, i) => [0.001 * Math.cos(2 * Math.PI * i / 1001), 0.001 * Math.sin(2 * Math.PI * i / 1001)]);
  ring.push(ring[0]);
  assert.throws(() => planMission({ type: 'Polygon', coordinates: [ring] }), /1000-vertex/);
});

test('handles a triangle narrower than the requested spacing and explicit altitude', () => {
  const plan = planMission({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[77, 12], [77.00002, 12], [77.00001, 12.00002], [77, 12]]] } }, { spacingM: 1000, altitudeM: 77 });
  assert.equal(plan.waypoints.length, 2);
  assert.ok(plan.waypoints.every(p => p.altitudeM === 77));
  assert.ok(plan.distanceM > 0 && plan.distanceM < 3);
});

test('exports 2D GeoJSON positions and keeps relative altitude in properties', () => {
  const plan = planMission(rectangle, { altitudeM: 77 });
  const route = plan.geojson.features[1];
  assert.ok(route.geometry.coordinates.every(position => position.length === 2));
  assert.equal(route.properties.altitudeM, 77);
  assert.equal(route.properties.altitudeReference, 'above-takeoff');
  assert.ok(plan.waypoints.every(point => point.altitudeM === 77));
  assert.deepEqual(route.geometry.coordinates, plan.waypoints.map(point => [point.lon, point.lat]));
});

test('rejects adjacent backtracking edges before trying to create a route', () => {
  const ring = [[0, 0], [0.001, 0], [0.0005, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
  assert.throws(() => planMission({ type: 'Polygon', coordinates: [ring] }), /Adjacent polygon edges cannot overlap/);
});

test('stops overly complex visibility work with a bounded input error', () => {
  const ring = Array.from({ length: 400 }, (_, i) => {
    const radius = i % 2 ? 0.0006 : 0.001;
    const angle = 2 * Math.PI * i / 400;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  ring.push(ring[0]);
  assert.throws(() => planMission({ type: 'Polygon', coordinates: [ring] }, { spacingM: 30 }), /bounded planning work limit/);
});

test('returns deterministic route geometry and measured sums', () => {
  const first = planMission(rectangle);
  const second = planMission(rectangle);
  assert.deepEqual(first, second);
  assert.equal(first.legs.length, first.waypoints.length - 1);
  assert.deepEqual(first.geojson.features[0].geometry, rectangle);
  assert.ok(first.legs.some(leg => leg.kind === 'survey'));
  assert.ok(first.legs.some(leg => leg.kind === 'transit'));
});
