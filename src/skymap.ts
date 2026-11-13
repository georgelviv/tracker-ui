// Satellites drawn on the map: a line from the tracker toward each satellite,
// ending at the point on Earth the satellite is directly above.
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Constellation, Sat } from './types';
import { satId } from './sky';

const R_EARTH = 6371; // km

// Orbit altitude, km. BeiDou also has geostationary and inclined
// geosynchronous satellites much higher up than its MEO ones.
const BEIDOU_HIGH = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 16, 31, 38, 39, 40, 56, 59, 60, 61, 62, 63]);
function altitudeKm(s: Sat): number {
  switch (s.sys) {
    case 'gps':
      return 20180;
    case 'glonass':
      return 19130;
    case 'galileo':
      return 23222;
    case 'beidou':
      return BEIDOU_HIGH.has(s.prn) ? 35786 : 21528;
  }
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

// Point `angle` radians along the great circle from (lat, lon) at bearing `az`.
function travel(lat: number, lon: number, az: number, angle: number): [number, number] {
  const p0 = rad(lat);
  const p = Math.asin(Math.sin(p0) * Math.cos(angle) + Math.cos(p0) * Math.sin(angle) * Math.cos(az));
  const l = rad(lon) + Math.atan2(Math.sin(az) * Math.sin(angle) * Math.cos(p0), Math.cos(angle) - Math.sin(p0) * Math.sin(p));
  return [((deg(l) + 540) % 360) - 180, deg(p)];
}

// Earth-centre angle between the observer and the point under the satellite.
function centralAngle(s: Sat): number {
  const el = rad(s.el!);
  return Math.acos((R_EARTH / (R_EARTH + altitudeKm(s))) * Math.cos(el)) - el;
}

export function subSatellitePoint(lat: number, lon: number, s: Sat): [number, number] {
  return travel(lat, lon, rad(s.az!), centralAngle(s));
}

function sysColor(sys: Constellation): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--sys-${sys}`).trim() || '#888';
}

type Feature = {
  type: 'Feature';
  properties: Record<string, string>;
  geometry: { type: 'LineString'; coordinates: [number, number][] } | { type: 'Point'; coordinates: [number, number] };
};

const SOURCE = 'sky-sats';
let last: { origin?: [number, number]; sky?: Sat[]; on: boolean } = { on: false };

function features(origin: [number, number], sky: Sat[]) {
  const [lon, lat] = origin;
  const out: Feature[] = [];
  for (const s of sky) {
    if (s.el == null || s.az == null) continue;
    const angle = centralAngle(s);
    const props = {
      id: satId(s),
      color: sysColor(s.sys),
      state: s.used ? 'used' : s.snr != null ? 'heard' : 'silent',
    };
    const line: [number, number][] = [];
    for (let i = 0; i <= 48; i++) line.push(travel(lat, lon, rad(s.az), (angle * i) / 48));
    out.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: line } });
    out.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: line[line.length - 1] } });
  }
  return { type: 'FeatureCollection' as const, features: out };
}

function ensureLayers(map: MapLibreMap) {
  if (map.getSource(SOURCE)) return;
  map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const isLine: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
  const isPoint: ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
  const isUsed: ExpressionSpecification = ['==', ['get', 'state'], 'used'];
  const opacity: ExpressionSpecification = ['match', ['get', 'state'], 'used', 0.9, 'heard', 0.6, 0.3];
  map.addLayer({
    id: 'sky-rays-used',
    type: 'line',
    source: SOURCE,
    filter: ['all', isLine, isUsed],
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': opacity },
    layout: { 'line-cap': 'round' },
  });
  map.addLayer({
    id: 'sky-rays-other',
    type: 'line',
    source: SOURCE,
    filter: ['all', isLine, ['!', isUsed]],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 1.5,
      'line-opacity': opacity,
      'line-dasharray': [2, 2],
    },
  });
  map.addLayer({
    id: 'sky-dots',
    type: 'circle',
    source: SOURCE,
    filter: isPoint,
    paint: {
      'circle-radius': 6,
      'circle-color': ['get', 'color'],
      'circle-opacity': opacity,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': opacity,
    },
  });
  map.addLayer({
    id: 'sky-labels',
    type: 'symbol',
    source: SOURCE,
    filter: isPoint,
    layout: {
      'text-field': ['get', 'id'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#1f2328', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });
}

function apply(map: MapLibreMap) {
  try {
    ensureLayers(map);
  } catch {
    return; // style still loading; 'style.load' calls back in
  }
  const data =
    last.on && last.origin && last.sky?.length
      ? features(last.origin, last.sky)
      : { type: 'FeatureCollection' as const, features: [] };
  (map.getSource(SOURCE) as GeoJSONSource).setData(data);
}

const hooked = new WeakSet<MapLibreMap>();

// Draws (or clears) the satellites for the current position and sky.
export function updateSkyMap(map: MapLibreMap | undefined, origin: [number, number] | undefined, sky: Sat[] | undefined, on: boolean) {
  last = { origin, sky, on };
  if (!map) return;
  if (!hooked.has(map)) {
    hooked.add(map);
    // A style change (light/dark) drops custom layers; put them back.
    map.on('style.load', () => apply(map));
  }
  apply(map);
}

// Bounds covering the tracker and every satellite's ground point.
export function skyBounds(origin: [number, number], sky: Sat[]): [[number, number], [number, number]] | undefined {
  const pts = sky.filter((s) => s.el != null && s.az != null).map((s) => subSatellitePoint(origin[1], origin[0], s));
  if (!pts.length) return undefined;
  pts.push(origin);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}
