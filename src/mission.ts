import { QethError } from './errors.ts';

type Point = [number, number];
type Ring = Point[];

export interface MissionOptions {
  spacingM?: number;
  speedMps?: number;
  altitudeM?: number;
  batteryMinutes?: number;
  reservePercent?: number;
  optimize?: 'battery' | 'distance';
}

interface Assumptions {
  spacingM: number;
  speedMps: number;
  altitudeM: number;
  batteryMinutes: number;
  reservePercent: number;
  optimize: 'battery' | 'distance';
  projection: string;
}

export interface MissionWaypoint { lon: number; lat: number; altitudeM: number }
export interface MissionLeg { from: Point; to: Point; kind: 'survey' | 'transit' }
interface PolygonGeometry { type: 'Polygon'; coordinates: Ring[] }
interface LineGeometry { type: 'LineString'; coordinates: number[][] }
interface GeoFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: PolygonGeometry | LineGeometry;
}

export interface MissionReport {
  schemaVersion: 1;
  kind: 'mission-plan';
  assumptions: Assumptions;
  waypoints: MissionWaypoint[];
  legs: MissionLeg[];
  distanceM: number;
  estimatedSeconds: number;
  usableBatterySeconds: number;
  estimatedBatteryPercent: number;
  withinBatteryBudget: boolean;
  warnings: string[];
  geojson: { type: 'FeatureCollection'; features: GeoFeature[] };
}

const RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;
const EPS = 1e-7;
const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readGeometry(input: unknown): PolygonGeometry {
  let geometry = input;
  if (record(geometry) && geometry.type === 'FeatureCollection') {
    if (!Array.isArray(geometry.features) || geometry.features.length !== 1) throw new QethError('Use exactly one Polygon feature.');
    geometry = geometry.features[0];
    if (!record(geometry) || geometry.type !== 'Feature') throw new QethError('FeatureCollection must contain one Feature.');
  }
  if (record(geometry) && geometry.type === 'Feature') geometry = geometry.geometry;
  if (!record(geometry) || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) {
    throw new QethError('Mission input must contain one GeoJSON Polygon.');
  }
  let count = 0;
  const coordinates: Ring[] = geometry.coordinates.map((value: unknown) => {
    if (!Array.isArray(value) || value.length < 4) throw new QethError('Each polygon ring needs at least four positions.');
    count += value.length;
    if (count > 1000) throw new QethError('Mission input exceeds the 1000-vertex limit.');
    const ring: Ring = value.map((p: unknown) => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(n => typeof n === 'number' && Number.isFinite(n))) throw new QethError('Each position must be a finite longitude/latitude pair.');
      const [lon, lat] = p as Point;
      if (lon < -180 || lon > 180 || Math.abs(lat) > 80) throw new QethError('Use longitudes in [-180, 180] and latitudes in [-80, 80].');
      return [lon, lat];
    });
    if (!same(ring[0]!, ring.at(-1)!)) throw new QethError('Polygon rings must be closed.');
    const unique = new Set(ring.slice(0, -1).map(p => `${p[0]},${p[1]}`));
    if (unique.size !== ring.length - 1) throw new QethError('Polygon rings cannot repeat a vertex except for closure.');
    return ring;
  });
  return { type: 'Polygon', coordinates };
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return Math.abs(cross(a, b, p)) <= EPS * Math.max(1, distance(a, b)) &&
    p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const sign = (v: number, length: number) => Math.abs(v) <= EPS * Math.max(1, length) ? 0 : Math.sign(v);
  const ac = sign(cross(a, b, c), distance(a, b)), ad = sign(cross(a, b, d), distance(a, b));
  const ca = sign(cross(c, d, a), distance(c, d)), cb = sign(cross(c, d, b), distance(c, d));
  return (ac * ad < 0 && ca * cb < 0) ||
    (!ac && onSegment(a, b, c)) || (!ad && onSegment(a, b, d)) ||
    (!ca && onSegment(c, d, a)) || (!cb && onSegment(c, d, b));
}

function validateRing(ring: Ring): void {
  const n = ring.length - 1;
  const area = ring.slice(0, -1).reduce((sum, p, i) => sum + p[0] * ring[i + 1]![1] - ring[i + 1]![0] * p[1], 0) / 2;
  if (Math.abs(area) < 1e-6) throw new QethError('Polygon ring has no usable area.');
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    if (distance(a, b) < EPS) throw new QethError('Polygon has a zero-length edge.');
    const c = ring[(i + 2) % n]!;
    if (Math.abs(cross(a, b, c)) < EPS * distance(a, b) && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      throw new QethError('Adjacent polygon edges cannot overlap.');
    }
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (intersects(a, b, ring[j]!, ring[j + 1]!)) throw new QethError('Polygon ring cannot cross or touch itself.');
    }
  }
}

class WorkBudget {
  private used = 0;
  use(count = 1): void {
    this.used += count;
    if (this.used > 8_000_000) throw new QethError('Geometry exceeds the bounded planning work limit; simplify the polygon or increase spacing.');
  }
}

function pointLocation(p: Point, ring: Ring, budget: WorkBudget): -1 | 0 | 1 {
  budget.use(ring.length);
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    if (onSegment(a, b, p)) return 0;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

function validateHoles(rings: Ring[], budget: WorkBudget): void {
  rings.forEach(validateRing);
  for (let i = 1; i < rings.length; i++) {
    const hole = rings[i]!;
    if (pointLocation(hole[0]!, rings[0]!, budget) !== 1) throw new QethError('Holes must be strictly inside the outer boundary.');
    for (let j = 0; j < i; j++) {
      const other = rings[j]!;
      for (let a = 0; a < hole.length - 1; a++) {
        for (let b = 0; b < other.length - 1; b++) {
          budget.use();
          if (intersects(hole[a]!, hole[a + 1]!, other[b]!, other[b + 1]!)) throw new QethError('Polygon boundaries cannot cross or touch.');
        }
      }
      if (j && (pointLocation(hole[0]!, other, budget) === 1 || pointLocation(other[0]!, hole, budget) === 1)) {
        throw new QethError('Holes cannot overlap or contain another hole.');
      }
    }
  }
}

function intersectionParameters(a: Point, b: Point, c: Point, d: Point): number[] {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  const tolerance = EPS / Math.max(1, distance(a, b));
  if (Math.abs(denominator) < EPS * Math.max(1, distance(a, b), distance(c, d))) {
    if (Math.abs(cross(a, b, c)) > EPS * Math.max(1, distance(a, b))) return [];
    const squared = rx * rx + ry * ry;
    return [c, d].map(p => ((p[0] - a[0]) * rx + (p[1] - a[1]) * ry) / squared)
      .filter(t => t >= -tolerance && t <= 1 + tolerance).map(t => Math.max(0, Math.min(1, t)));
  }
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
  return t >= -tolerance && t <= 1 + tolerance && u >= -tolerance && u <= 1 + tolerance ? [Math.max(0, Math.min(1, t))] : [];
}

interface Neighbor { index: number; cost: number }

class Region {
  readonly vertices: Point[];
  readonly edges: [Point, Point][];
  readonly rings: Ring[];
  private budget: WorkBudget;
  private graph: Neighbor[][] | undefined;
  constructor(rings: Ring[], budget: WorkBudget) {
    this.rings = rings;
    this.budget = budget;
    this.vertices = rings.flatMap(ring => ring.slice(0, -1));
    this.edges = rings.flatMap(ring => ring.slice(0, -1).map((p, i): [Point, Point] => [p, ring[i + 1]!]));
  }

  allowed(p: Point): boolean {
    return pointLocation(p, this.rings[0]!, this.budget) >= 0 &&
      this.rings.slice(1).every(ring => pointLocation(p, ring, this.budget) !== 1);
  }

  segmentAllowed(a: Point, b: Point): boolean {
    if (!this.allowed(a) || !this.allowed(b)) return false;
    if (distance(a, b) <= EPS) return true;
    this.budget.use(this.edges.length);
    // A segment can change region only at a boundary intersection. Checking
    // every resulting open interval also catches concave gaps and vertex hits.
    const times = [0, 1, ...this.edges.flatMap(([c, d]) => intersectionParameters(a, b, c, d))].sort((x, y) => x - y);
    const tolerance = EPS / Math.max(1, distance(a, b));
    for (let i = 1; i < times.length; i++) {
      if (times[i]! - times[i - 1]! <= tolerance) continue;
      const t = (times[i]! + times[i - 1]!) / 2;
      if (!this.allowed([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
    return true;
  }

  private visibilityGraph(): Neighbor[][] {
    if (this.graph) return this.graph;
    const graph: Neighbor[][] = this.vertices.map(() => []);
    for (let i = 0; i < this.vertices.length; i++) {
      for (let j = i + 1; j < this.vertices.length; j++) {
        if (this.segmentAllowed(this.vertices[i]!, this.vertices[j]!)) {
          const cost = distance(this.vertices[i]!, this.vertices[j]!);
          graph[i]!.push({ index: j, cost });
          graph[j]!.push({ index: i, cost });
        }
      }
    }
    this.graph = graph;
    return graph;
  }

  path(a: Point, b: Point): Point[] {
    if (this.segmentAllowed(a, b)) return [a, b];
    const graph = this.visibilityGraph();
    const costs = this.vertices.map(p => this.segmentAllowed(a, p) ? distance(a, p) : Infinity);
    const toEnd = this.vertices.map(p => this.segmentAllowed(p, b) ? distance(p, b) : Infinity);
    const previous = this.vertices.map(() => -1), visited = this.vertices.map(() => false);
    let best = Infinity, terminal = -1;
    for (let step = 0; step < this.vertices.length; step++) {
      this.budget.use(this.vertices.length);
      let current = -1, minimum = Infinity;
      for (let i = 0; i < costs.length; i++) if (!visited[i] && costs[i]! < minimum) { current = i; minimum = costs[i]!; }
      if (current < 0 || minimum >= best) break;
      visited[current] = true;
      if (minimum + toEnd[current]! < best) { best = minimum + toEnd[current]!; terminal = current; }
      for (const next of graph[current]!) {
        this.budget.use();
        if (minimum + next.cost < costs[next.index]!) { costs[next.index] = minimum + next.cost; previous[next.index] = current; }
      }
    }
    if (terminal < 0) throw new QethError('Cannot connect survey legs with a feasible route inside this polygon.');
    const path: Point[] = [b];
    for (let i = terminal; i >= 0; i = previous[i]!) path.push(this.vertices[i]!);
    path.push(a);
    return path.reverse();
  }
}

function surveyLegs(region: Region, spacing: number, vertical: boolean): [Point, Point][] | null {
  const rotate = ([x, y]: Point): Point => vertical ? [y, x] : [x, y];
  const rings = region.rings.map(ring => ring.map(rotate));
  const points = rings[0]!;
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const rows = Math.max(1, Math.ceil((maxY - minY) / spacing));
  if (rows > 1000) return null;
  const legs: [Point, Point][] = [];
  for (let i = 0; i < rows; i++) {
    const y = minY + (i + 0.5) * (maxY - minY) / rows;
    const crossings: number[] = [];
    for (const ring of rings) {
      for (let j = 0; j < ring.length - 1; j++) {
        const a = ring[j]!, b = ring[j + 1]!;
        if ((a[1] > y) !== (b[1] > y)) crossings.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
      }
    }
    crossings.sort((a, b) => a - b);
    if (crossings.length % 2) throw new QethError('Polygon scan-line intersections are numerically unstable.');
    const row: [Point, Point][] = [];
    for (let j = 0; j < crossings.length; j += 2) {
      if (crossings[j + 1]! - crossings[j]! > EPS) row.push([rotate([crossings[j]!, y]), rotate([crossings[j + 1]!, y])]);
    }
    if (i % 2) row.reverse().forEach(leg => leg.reverse());
    if (legs.length + row.length > 1000) return null;
    legs.push(...row);
  }
  return legs;
}

function connectSurvey(region: Region, legs: [Point, Point][]): { route: Point[]; kinds: MissionLeg['kind'][]; distanceM: number } {
  const route: Point[] = [], kinds: MissionLeg['kind'][] = [];
  const append = (point: Point, kind: MissionLeg['kind']) => {
    if (route.length && distance(route.at(-1)!, point) <= EPS) return;
    if (route.length >= 10000) throw new QethError('Survey exceeds the 10000-waypoint work limit; simplify the polygon or increase spacing.');
    if (route.length) kinds.push(kind);
    route.push(point);
  };
  for (const [start, end] of legs) {
    if (route.length) region.path(route.at(-1)!, start).slice(1).forEach(p => append(p, 'transit'));
    else append(start, 'transit');
    if (!region.segmentAllowed(start, end)) throw new QethError('Clipped survey leg leaves the permitted area.');
    append(end, 'survey');
  }
  if (route.length < 2) throw new QethError('Polygon has no usable survey legs.');
  return { route, kinds, distanceM: route.slice(1).reduce((sum, p, i) => sum + distance(route[i]!, p), 0) };
}

function assumptionsFrom(options: MissionOptions): Assumptions {
  if (!record(options)) throw new QethError('Mission options must be an object.');
  const number = (key: keyof MissionOptions, fallback: number, min: number, max: number): number => {
    const value = Object.hasOwn(options, key) ? options[key] : fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new QethError(`${key} must be a finite number from ${min} to ${max}.`);
    return value;
  };
  const optimize = Object.hasOwn(options, 'optimize') ? options.optimize : 'battery';
  if (optimize !== 'battery' && optimize !== 'distance') throw new QethError('optimize must be battery or distance.');
  return {
    spacingM: number('spacingM', 20, 1, 1000),
    speedMps: number('speedMps', 5, 0.1, 100),
    altitudeM: number('altitudeM', 30, 1, 500),
    batteryMinutes: number('batteryMinutes', 25, 1, 1440),
    reservePercent: number('reservePercent', 20, 0, 90),
    optimize,
    projection: 'Local equirectangular projection on a sphere of radius 6371008.8 m'
  };
}

function makeReport(geometry: PolygonGeometry, route: Point[], kinds: MissionLeg['kind'][], assumptions: Assumptions, inverse: (p: Point) => Point): MissionReport {
  const coords = route.map(inverse);
  const waypoints = coords.map(([lon, lat]) => ({ lon, lat, altitudeM: assumptions.altitudeM }));
  const legs = coords.slice(1).map((to, i) => ({ from: coords[i]!, to, kind: kinds[i]! }));
  const distanceM = route.slice(1).reduce((sum, p, i) => sum + distance(route[i]!, p), 0);
  const estimatedSeconds = distanceM / assumptions.speedMps;
  const usableBatterySeconds = assumptions.batteryMinutes * 60 * (1 - assumptions.reservePercent / 100);
  return {
    schemaVersion: 1, kind: 'mission-plan', assumptions, waypoints, legs, distanceM,
    estimatedSeconds, usableBatterySeconds,
    estimatedBatteryPercent: estimatedSeconds / (assumptions.batteryMinutes * 60) * 100,
    withinBatteryBudget: estimatedSeconds <= usableBatterySeconds,
    warnings: ['Offline open route. Wind, acceleration, takeoff/landing and hardware limits are not modeled. No implicit return-to-home segment is included.'],
    geojson: {
      type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { role: 'survey-boundary' }, geometry },
        { type: 'Feature', properties: { role: 'offline-survey-route', altitudeM: assumptions.altitudeM, altitudeReference: 'above-takeoff' }, geometry: { type: 'LineString', coordinates: waypoints.map(p => [p.lon, p.lat]) } }
      ]
    }
  };
}

export function planMission(input: unknown, options: MissionOptions = {}): MissionReport {
  const assumptions = assumptionsFrom(options);
  const geometry = readGeometry(input);
  const ring = geometry.coordinates[0]!;
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const scaleX = RADIUS_M * RAD * Math.cos(lat0 * RAD);
  const scaleY = RADIUS_M * RAD;
  const rings: Ring[] = geometry.coordinates.map(r => r.map(([lon, lat]): Point => [(lon - lon0) * scaleX, (lat - lat0) * scaleY]));
  const points = rings.flat();
  const inverse = ([x, y]: Point): Point => [x / scaleX + lon0, y / scaleY + lat0];
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  if (Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) > 180) throw new QethError('Antimeridian polygons are not supported.');
  if (Math.hypot(maxX - minX, maxY - minY) > 20_000) throw new QethError('Projected bounding-box diagonal must not exceed 20 km.');
  const budget = new WorkBudget();
  validateHoles(rings, budget);
  const region = new Region(rings, budget);
  const candidates = [false, true].map(vertical => surveyLegs(region, assumptions.spacingM, vertical));
  let chosen: ReturnType<typeof connectSurvey> | undefined;
  for (const legs of candidates) {
    if (!legs) continue;
    const candidate = connectSurvey(region, legs);
    if (!chosen || candidate.distanceM < chosen.distanceM) chosen = candidate;
  }
  if (!chosen) throw new QethError('Survey exceeds the 1000-leg work limit; increase spacing.');
  return makeReport(geometry, chosen.route, chosen.kinds, assumptions, inverse);
}
