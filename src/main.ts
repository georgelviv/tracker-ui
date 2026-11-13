import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { onValue, ref, type Unsubscribe } from 'firebase/database';
import { auth, db } from './firebase';
import { recordSky, renderLegend, renderSignalBars, renderSkyPlot } from './sky';
import { skyBounds, updateSkyMap } from './skymap';
import type { Constellation, Device, Fix, Sat, Status } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- auth ----------

const AUTH_ERRORS: Record<string, string> = {
  'auth/invalid-credential': 'Wrong e-mail or password.',
  'auth/invalid-email': 'That e-mail address looks invalid.',
  'auth/too-many-requests': 'Too many attempts. Try again in a few minutes.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
};

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const submit = $<HTMLButtonElement>('login-submit');
  $('login-error').textContent = '';
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    await signInWithEmailAndPassword(
      auth,
      $<HTMLInputElement>('email').value,
      $<HTMLInputElement>('password').value,
    );
    await offerToSavePassword(form);
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    $('login-error').textContent = AUTH_ERRORS[code] ?? (err as Error).message;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

// The form never really submits (no page navigation), so Chrome's password
// manager may not notice the login. The Credential Management API tells it
// explicitly; browsers without it simply skip this.
declare global {
  interface Window {
    PasswordCredential?: new (form: HTMLFormElement) => Credential;
  }
}
async function offerToSavePassword(form: HTMLFormElement) {
  if (!window.PasswordCredential) return;
  try {
    await navigator.credentials.store(new window.PasswordCredential(form));
  } catch {
    // User dismissed, or the browser refused; nothing to do.
  }
}

$('logout').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  $('login').hidden = !!user;
  $('app').hidden = !user;
  if (user) startTracking();
  else stopTracking();
});

// ---------- map ----------

// MapLibre finds its worker next to its own module by default, which breaks
// once Vite bundles it; point it at the worker file Vite emits instead.
maplibregl.setWorkerUrl(workerUrl);

let map: maplibregl.Map | undefined;
let marker: maplibregl.Marker | undefined;
let pinEl: HTMLDivElement | undefined;
let deviceId: string | undefined;
let latest: Fix | undefined;
let status: Status | undefined;
let centeredOnce = false;
const unsubs: Unsubscribe[] = [];
let unsubDevice: Unsubscribe | undefined;

// OpenFreeMap vector tiles (OpenStreetMap data, drawn in the browser).
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const mapStyle = () =>
  `https://tiles.openfreemap.org/styles/${darkScheme.matches ? 'dark' : 'liberty'}`;

function ensureMap() {
  if (map) return map;
  map = new maplibregl.Map({
    container: 'map',
    style: mapStyle(),
    center: [24.03, 49.84],
    zoom: 12,
    maxZoom: 19,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  darkScheme.addEventListener('change', () => map?.setStyle(mapStyle()));
  applyMapPadding();
  return map;
}

function startTracking() {
  ensureMap();
  // The container was hidden while the map initialised.
  setTimeout(() => map?.resize(), 0);

  // One tracker for now: use the first registered device.
  unsubs.push(
    onValue(ref(db, 'deviceWriters'), (snap) => {
      let first: string | undefined;
      snap.forEach((child) => {
        first ??= child.key!;
        return true; // stop after the first one
      });
      if (first !== deviceId) watchDevice(first);
    }),
  );
}

function watchDevice(id: string | undefined) {
  unsubDevice?.();
  unsubDevice = undefined;
  deviceId = id;
  latest = undefined;
  status = undefined;
  centeredOnce = false;
  if (id) {
    unsubDevice = onValue(ref(db, `devices/${id}`), (snap) => {
      const v = (snap.val() as { latest?: Fix; status?: Status } | null) ?? {};
      latest = v.latest;
      status = v.status;
      render();
    });
  }
  render();
}

function stopTracking() {
  unsubs.splice(0).forEach((u) => u());
  watchDevice(undefined);
}

// ---------- panel ----------

// live: online with a fix · searching: online, no fix · recent/stale: offline
type Freshness = 'live' | 'searching' | 'recent' | 'stale' | 'none';

// When the tracker last checked in (status), falling back to the last fix
// for data from firmware that did not send status yet.
function lastSeen(): number | undefined {
  return Math.max(status?.receivedAt ?? 0, latest?.receivedAt ?? latest?.ts ?? 0) || undefined;
}

function freshness(): Freshness {
  const seen = lastSeen();
  if (!seen) return 'none';
  const age = Date.now() - seen;
  if (age < 2 * 60_000) return status && status.gps.state !== 'fix' ? 'searching' : 'live';
  if (age < 15 * 60_000) return 'recent';
  return 'stale';
}

function satsInView(s?: { inView?: Partial<Record<string, number>> }): number {
  return Object.values(s?.inView ?? {}).reduce<number>((n, v) => n + (v ?? 0), 0);
}

function statusLine(fresh: Freshness): string {
  if (!deviceId) return 'No tracker is registered yet.';
  const seen = lastSeen();
  if (!seen) return 'Waiting for the tracker to report…';
  if (fresh === 'live') return `Live · updated ${formatAgo(seen)}`;
  if (fresh === 'searching') {
    if (status!.gps.state === 'no-data') return 'Online · GPS module not responding';
    return `Online · searching for GPS (${satsInView(status!.gps)} in view)`;
  }
  return `Last seen ${formatAgo(seen)}`;
}

function accuracyLabel(hdop?: number): string {
  if (hdop == null || hdop <= 0) return '–';
  if (hdop < 1) return 'Excellent';
  if (hdop < 2) return 'Good';
  if (hdop < 5) return 'Moderate';
  return 'Poor';
}

function render() {
  const f = latest;
  const fresh = freshness();
  const searching = fresh === 'searching';

  $('device-name').textContent = deviceId ?? 'No tracker';
  $('status-dot').className = `status-dot ${fresh}`;
  $('status-text').textContent = statusLine(fresh);

  // While searching the last fix is old: hide its speed, show live satellites.
  $('stat-speed').textContent = f && !searching ? `${Math.round(f.speed ?? 0)} km/h` : '–';
  const sats = searching ? status!.gps.sats : f?.sats;
  $('stat-sats').textContent = sats != null ? String(sats) : '–';
  $('stat-accuracy').textContent = f ? accuracyLabel(f.hdop) : '–';
  $('stat-alt').textContent = f?.alt != null ? `${Math.round(f.alt)} m` : '–';

  const coords = $<HTMLButtonElement>('coords');
  coords.disabled = !f;
  coords.textContent = f ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : '–';

  $<HTMLButtonElement>('center').disabled = !f;
  const gmaps = $<HTMLAnchorElement>('gmaps');
  gmaps.classList.toggle('is-disabled', !f);
  if (f) gmaps.href = `https://www.google.com/maps?q=${f.lat},${f.lon}`;
  else gmaps.removeAttribute('href');

  renderNet(f);
  renderCell();
  renderGps(f, fresh);
  renderDevice(status?.device ?? f?.device, !!(f || status));
  // The marker is the last known position; grey it out unless it is current.
  updateMarker(f, fresh === 'live' ? 'live' : fresh === 'recent' ? 'recent' : 'stale');
  updateSkyMap(map, skyOrigin(), status?.gps?.sky, skyOnMap.checked);
}

// ---------- satellites on the map ----------

const skyOnMap = $<HTMLInputElement>('sky-on-map');
const skyOrigin = (): [number, number] | undefined => (latest ? [latest.lon, latest.lat] : undefined);
try {
  skyOnMap.checked = localStorage.getItem('sky-on-map') === 'on';
} catch {
  /* storage blocked */
}
skyOnMap.addEventListener('change', () => {
  try {
    localStorage.setItem('sky-on-map', skyOnMap.checked ? 'on' : 'off');
  } catch {
    /* storage blocked */
  }
  const origin = skyOrigin();
  const sky = status?.gps?.sky;
  updateSkyMap(map, origin, sky, skyOnMap.checked);
  // Zoom out once so all the satellites' ground points are in view.
  if (skyOnMap.checked && map && origin && sky) {
    const b = skyBounds(origin, sky);
    if (b) map.fitBounds(b, { padding: 40, maxZoom: 6 });
  }
});

// ---------- detail sections ----------

type Row = [label: string, value: string | undefined, help?: string];

function setRows(id: string, rows: Row[]) {
  const dl = $(id);
  dl.replaceChildren(
    ...rows
      .filter(([, v]) => v != null && v !== '')
      .flatMap(([k, v, help]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v!;
        if (!help) return [dt, dd];
        // Shown only in "Explain" mode.
        const note = document.createElement('dd');
        note.className = 'help';
        note.textContent = help;
        return [dt, dd, note];
      }),
  );
}

function wifiQuality(rssi: number): string {
  if (rssi >= -55) return 'Excellent';
  if (rssi >= -67) return 'Good';
  if (rssi >= -75) return 'Fair';
  return 'Weak';
}

function formatDuration(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

const LINK_NAMES: Record<string, string> = { wifi: 'Wi-Fi', lte: 'LTE' };

function renderNet(f?: Fix) {
  const net = status?.net ?? f?.net;
  const known = !!(f || status);
  const type = LINK_NAMES[net?.type ?? f?.via ?? ''] ?? f?.via ?? '–';
  const lte = net?.type === 'lte';
  const quality = net?.rssi != null ? (lte ? rsrpQuality(net.rssi) : wifiQuality(net.rssi)) : undefined;
  const seen = lastSeen();
  $('net-summary').textContent = known ? [type, net?.name, quality].filter(Boolean).join(' · ') : '–';
  setRows('net-rows', [
    ['Type', known ? type : undefined],
    ['Network', net?.name],
    ['Signal', net?.rssi != null ? `${quality} (${lte ? 'RSRP ' : ''}${net.rssi} dBm)` : undefined],
    ['Channel', net?.channel != null ? String(net.channel) : undefined],
    ['Local IP', net?.ip],
    ['Last check-in', seen ? formatAgo(seen) : undefined],
  ]);
}

// Typical Li-ion resting voltage -> charge. Rough under load, good enough for a gauge.
const LIION_CURVE: [mv: number, pct: number][] = [
  [3300, 0], [3450, 5], [3550, 10], [3650, 20], [3700, 30], [3750, 40],
  [3800, 50], [3870, 60], [3950, 70], [4030, 80], [4100, 90], [4180, 100],
];

function batteryPercent(mv: number): number {
  if (mv <= LIION_CURVE[0][0]) return 0;
  for (let i = 1; i < LIION_CURVE.length; i++) {
    const [v1, p1] = LIION_CURVE[i];
    if (mv <= v1) {
      const [v0, p0] = LIION_CURVE[i - 1];
      return Math.round(p0 + ((mv - v0) / (v1 - v0)) * (p1 - p0));
    }
  }
  return 100;
}

const RESET_NAMES: Record<string, string> = {
  'power-on': 'Power on',
  software: 'Software restart',
  crash: 'Crash',
  watchdog: 'Watchdog (hang)',
  brownout: 'Brownout (voltage dip)',
  'power-glitch': 'Power glitch',
  'deep-sleep': 'Wake from sleep',
  external: 'Reset button',
};

function describePrevRun(p: NonNullable<Device['prev']>, boots?: number): string {
  const parts = [
    `boot #${p.boot}, ran ${p.uptime < 60 ? `${p.uptime} s` : formatDuration(p.uptime)}`,
    `${p.uploads} uploads`,
  ];
  if (p.failures) parts.push(`${p.failures} failed`);
  if (p.noFix) parts.push(`${p.noFix}× no fix`);
  if (p.minBattery) parts.push(`lowest ${(p.minBattery / 1000).toFixed(2)} V`);
  // Boots after the recorded run that never reached their first report.
  const lost = boots != null ? boots - p.boot - 1 : 0;
  if (lost > 0) parts.push(`then ${lost} start${lost > 1 ? 's' : ''} died before reporting`);
  return parts.join(' · ');
}

function renderDevice(d: Device | undefined, known: boolean) {
  const mv = d?.battery;
  // Above ~4.25 V the reading is the charger output on USB with no cell fitted.
  const external = mv != null && (mv > 4250 || mv < 2500);
  const pct = mv != null && !external ? batteryPercent(mv) : undefined;
  const volts = mv != null ? `${(mv / 1000).toFixed(2)} V` : undefined;

  const badge = $('battery');
  badge.hidden = mv == null;
  badge.className = `battery${external ? ' external' : pct! <= 10 ? ' critical' : pct! <= 25 ? ' low' : ''}`;
  $('battery-fill').style.width = `${external ? 100 : pct ?? 0}%`;
  $('battery-text').textContent = external ? 'USB' : `${pct}%`;
  badge.title = volts ? `Battery ${volts}` : '';

  const batteryText = external ? `USB power (${volts})` : pct != null ? `${pct}% (${volts})` : undefined;
  $('dev-summary').textContent = known
    ? [batteryText ? `Battery ${batteryText}` : undefined, d?.uptime != null ? `up ${formatDuration(d.uptime)}` : undefined]
        .filter(Boolean)
        .join(' · ') || '–'
    : '–';
  setRows('dev-rows', [
    ['Battery', batteryText],
    ['Uptime', d?.uptime != null ? formatDuration(d.uptime) : undefined],
    ['Last restart', d?.reset ? RESET_NAMES[d.reset] ?? d.reset : undefined],
    ['Boots', d?.boots != null ? String(d.boots) : undefined],
    ['Brownouts', d?.brownouts != null ? String(d.brownouts) : undefined],
    ['Previous run', d?.prev ? describePrevRun(d.prev, d.boots) : undefined],
    ['Firmware', d?.fw],
  ]);
}

const FIX_QUALITY: Record<number, string> = { 1: 'GPS', 2: 'DGPS', 4: 'RTK', 5: 'RTK float', 6: 'Estimated' };
const CONSTELLATIONS: [key: Constellation, name: string][] = [
  ['gps', 'GPS'],
  ['beidou', 'BeiDou'],
  ['glonass', 'GLONASS'],
  ['galileo', 'Galileo'],
];
const POS_MODES: Record<string, string> = {
  A: 'Autonomous (satellites only)',
  D: 'Differential (with corrections)',
  E: 'Estimated (dead reckoning)',
  N: 'No fix',
};
const ANTENNA: Record<string, string> = { OK: 'Connected', OPEN: 'Not detected', SHORT: 'Short circuit' };
// Typical ranging error of a single-frequency receiver, m (UERE); HDOP × this ≈ 1σ horizontal error.
const UERE_M = 3;

function compass(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

function inViewText(view: Partial<Record<string, number>>): string {
  return CONSTELLATIONS.filter(([k]) => view[k]).map(([k, name]) => `${name} ${view[k]}`).join(' · ') || '0';
}

function utcTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

const HELP = {
  fix:
    'A 2D fix uses 3 satellites and gives only latitude and longitude. A 3D fix uses 4 or more and adds altitude. ' +
    'The fourth unknown is the error of the receiver’s own clock, which is why 4 satellites are the minimum.',
  mode: 'How the position was computed. "Autonomous" means from satellite signals alone, with no correction service.',
  used:
    'Not every satellite in view is used. Each one must be heard clearly for about 30 s while the receiver ' +
    'downloads its exact orbit (ephemeris). Weak or very low satellites are left out.',
  inView: 'Satellites above the horizon, according to the orbit almanac the satellites broadcast.',
  signal:
    'Carrier-to-noise density (C/N0) in dB-Hz: signal power relative to the noise in 1 Hz of bandwidth. ' +
    'GPS signals reach the ground far below the noise floor (≈ −130 dBm), so receivers report C/N0 instead of dBm.',
  accuracy:
    'An estimate, not a guarantee. The true position is inside this radius about 2 times out of 3 (1σ). ' +
    'Without the receiver’s own error estimate it is HDOP × ≈3 m, the typical range error.',
  dop:
    'Dilution of precision: how much the satellite geometry magnifies range errors. Satellites spread across the ' +
    'sky give low values (≈1, good). Satellites bunched together give high values (over 5, poor). ' +
    'P = 3D position, H = horizontal, V = vertical.',
  altitude:
    'Height above mean sea level. Vertical accuracy is usually about 1.5× worse than horizontal, because all ' +
    'satellites are above you and none are below.',
  ellipsoid:
    'GPS natively computes height above the WGS-84 ellipsoid, a smooth mathematical model of the Earth. ' +
    'The geoid separation (local sea level above the ellipsoid) converts it to altitude.',
  heading: 'Direction of travel, computed from movement. It is not a compass, so it is only shown while moving.',
  ttff:
    'Time from power-on to the first fix. A cold start, with no orbit data saved, takes 30 s or more. ' +
    'A warm start with recent data takes a few seconds.',
  clock:
    'Satellites carry atomic clocks. Once the receiver hears one, it knows UTC to within microseconds, even before ' +
    'it has a fix.',
  delay: 'Time between the receiver computing this fix and the database receiving it.',
  antenna:
    'The receiver checks the current drawn by an active antenna. "Not detected" is normal with a passive antenna.',
  searching:
    'It needs at least 4 satellites, each heard clearly for about 30 s, to download their orbits and compute a fix.',
};

function renderSky(sky: Sat[] | undefined) {
  const has = !!sky?.length;
  $('sky-figure').hidden = !has;
  $('sig-figure').hidden = !has;
  document.querySelector<HTMLElement>('.sky-key')!.hidden = !has;
  if (!has) return;
  recordSky(sky, status?.receivedAt ?? 0);
  renderSkyPlot($('sky-figure'), sky!);
  renderSignalBars($('sig-figure'), sky!);
  renderLegend($('sky-legend'), sky!);
}

function signalText(g?: { snrAvg?: number; snrMax?: number }): string | undefined {
  return g?.snrAvg ? `avg ${Math.round(g.snrAvg)} · best ${g.snrMax} dB-Hz` : undefined;
}

function renderGps(f: Fix | undefined, fresh: Freshness) {
  if (fresh === 'searching') return renderGpsSearching(f);
  const g = f?.gps;
  // Receiver details from the latest check-in, when it belongs to this fix.
  const rcv = status?.gps.state === 'fix' ? status.gps : undefined;
  renderSky(rcv?.sky);

  const fixType = g?.fixType === 3 ? '3D fix' : g?.fixType === 2 ? '2D fix' : g ? 'No fix' : undefined;
  const inView = satsInView(g);
  const sats = f?.sats != null ? (g ? `${f.sats} of ${inView}` : String(f.sats)) : undefined;

  $('gps-summary').textContent = f
    ? [fixType, sats && `${sats} satellites`].filter(Boolean).join(' · ') || '–'
    : '–';
  const dop = (v?: number) => (v != null && v > 0 ? v.toFixed(1) : '–');
  const err = rcv?.err;
  const accuracy = err
    ? `±${Math.max(err.lat, err.lon).toFixed(1)} m (vertical ±${err.alt.toFixed(1)} m)`
    : f?.hdop
      ? `≈ ±${Math.max(1, Math.round(f.hdop * UERE_M))} m · ${accuracyLabel(f.hdop)}`
      : undefined;
  const delay = f?.receivedAt && f.ts ? (f.receivedAt - f.ts) / 1000 : undefined;
  setRows('gps-rows', [
    ['Fix', fixType && [fixType, FIX_QUALITY[g?.quality ?? -1]].filter(Boolean).join(', '), HELP.fix],
    ['Mode', rcv?.mode ? POS_MODES[rcv.mode] ?? rcv.mode : undefined, HELP.mode],
    ['Satellites used', sats, HELP.used],
    ['In view', g?.inView ? inViewText(g.inView) : undefined, HELP.inView],
    ['Signal', signalText(g), HELP.signal],
    ['Accuracy', accuracy, HELP.accuracy],
    ['DOP (P / H / V)', g ? `${dop(g.pdop)} / ${dop(f?.hdop)} / ${dop(g.vdop)}` : undefined, HELP.dop],
    ['Altitude', f?.alt != null ? `${f.alt.toFixed(1)} m above sea level` : undefined, HELP.altitude],
    [
      'Ellipsoid height',
      f?.alt != null && g?.geoid ? `${(f.alt + g.geoid).toFixed(1)} m (geoid +${g.geoid.toFixed(1)} m)` : undefined,
      HELP.ellipsoid,
    ],
    ['Speed', f ? `${(f.speed ?? 0).toFixed(1)} km/h` : undefined],
    [
      'Heading',
      f?.course != null && (f.speed ?? 0) >= 2 ? `${Math.round(f.course)}° ${compass(f.course)}` : f ? 'standing still' : undefined,
      HELP.heading,
    ],
    ['Time to first fix', rcv?.ttff != null ? `${rcv.ttff} s after power-on` : undefined, HELP.ttff],
    ['GPS time', f ? utcTime(f.ts) : undefined, HELP.clock],
    ['Upload delay', delay != null && delay >= 0 && delay < 600 ? `${delay.toFixed(1)} s` : undefined, HELP.delay],
    ['Antenna', rcv?.antenna ? ANTENNA[rcv.antenna] ?? rcv.antenna : undefined, HELP.antenna],
  ]);
}

// Online without a fix: show what the receiver sees right now.
function renderGpsSearching(f?: Fix) {
  const g = status!.gps;
  const noData = g.state === 'no-data';
  const n = satsInView(g);
  renderSky(noData ? undefined : g.sky);
  const heard = g.sky?.filter((s) => s.snr != null).length;
  $('gps-summary').textContent = noData ? 'Module not responding' : `Searching · ${n} in view`;
  setRows('gps-rows', [
    ['Fix', noData ? 'No data from the GPS module' : 'Searching for satellites', noData ? undefined : HELP.searching],
    ['Mode', g.mode ? POS_MODES[g.mode] ?? g.mode : undefined, HELP.mode],
    ['Satellites used', noData ? undefined : String(g.sats ?? 0), HELP.used],
    ['In view', noData ? undefined : inViewText(g.inView ?? {}), HELP.inView],
    ['Received', heard != null ? `${heard} with a signal` : undefined],
    ['Signal', signalText(g), HELP.signal],
    ['GPS time', g.clock ? utcTime(g.clock) : noData ? undefined : 'not known yet', HELP.clock],
    ['Antenna', g.antenna ? ANTENNA[g.antenna] ?? g.antenna : undefined, HELP.antenna],
    ['Last fix', f ? formatAgo(f.receivedAt ?? f.ts) : 'never'],
  ]);
}

// "Explain" shows a short description under each value (GPS and mobile sections).
{
  const bodies = document.querySelectorAll<HTMLElement>('.section-body');
  const buttons = document.querySelectorAll<HTMLButtonElement>('.explain-btn');
  const apply = (on: boolean) => {
    bodies.forEach((b) => b.classList.toggle('explain', on));
    buttons.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? 'Hide explanations' : 'Explain';
    });
  };
  let on = false;
  try {
    on = localStorage.getItem('gps-explain') === 'on';
  } catch {
    /* storage blocked */
  }
  apply(on);
  buttons.forEach((btn) =>
    btn.addEventListener('click', () => {
      on = !on;
      apply(on);
      try {
        localStorage.setItem('gps-explain', on ? 'on' : 'off');
      } catch {
        /* storage blocked */
      }
    }),
  );
}

// ---------- mobile network ----------

const REG_NAMES: Record<number, string> = {
  0: 'Not registered',
  1: 'Registered (home network)',
  2: 'Searching for a network',
  3: 'Registration denied',
  4: 'Unknown',
  5: 'Registered (roaming)',
};
const SIM_NAMES: Record<string, string> = {
  ready: 'Ready',
  'SIM not inserted': 'Not inserted',
  'SIM failure': 'Not detected',
  'SIM PIN': 'Locked (PIN required)',
  'SIM PUK': 'Blocked (PUK required)',
  'SIM busy': 'Starting up',
};
// LTE reference signal power: what phones turn into "bars".
function rsrpQuality(dbm: number): string {
  if (dbm >= -80) return 'Excellent';
  if (dbm >= -90) return 'Good';
  if (dbm >= -100) return 'Fair';
  if (dbm >= -110) return 'Weak';
  return 'Very weak';
}
function gsmQuality(dbm: number): string {
  if (dbm >= -70) return 'Excellent';
  if (dbm >= -85) return 'Good';
  if (dbm >= -100) return 'Fair';
  return 'Weak';
}

const CELL_HELP = {
  status:
    'Whether the modem is attached to a mobile network. It needs a SIM to register. Roaming means a network ' +
    'other than the SIM\u2019s own.',
  sim: 'The SIM identifies the subscription to the network. Without one, the modem can only listen.',
  network: 'Radio technology of the serving cell: LTE (4G) or GSM (2G). The A7670 has no 3G.',
  code:
    'Mobile Country Code + Mobile Network Code. The MCC is the country (255 = Ukraine) and the MNC is the ' +
    'operator within it.',
  signal:
    'LTE: RSRP, the power of the tower\u2019s reference signal, in dBm. −80 or higher is excellent, −100 is ' +
    'fair, below −110 data gets unreliable. GSM: received power in dBm.',
  rsrq:
    'Reference signal quality: how much of the received power is the tower\u2019s signal rather than ' +
    'interference and load. −3 to −10 dB is good, below −15 dB poor.',
  sinr:
    'Signal to interference plus noise ratio. Above 13 dB is excellent, 0–13 dB usable, below 0 the noise ' +
    'is louder than the signal.',
  rssi: 'Total received power on the channel, including noise and other cells. Less useful than RSRP on its own.',
  band: 'Frequency band of the serving cell, e.g. LTE band 3 = 1800 MHz, band 20 = 800 MHz, band 7 = 2600 MHz.',
  channel: 'Exact carrier frequency number within the band: EARFCN on LTE, ARFCN on GSM.',
  cell:
    'Which tower and antenna the modem is using. On LTE the cell id = base station (eNodeB) × 256 + sector. ' +
    'The area code groups nearby towers.',
  temp: 'Temperature inside the modem chip. It warms up while transmitting.',
  imei: 'The modem\u2019s unique hardware id. The network sees it, together with the SIM number.',
  iccid: 'The SIM card\u2019s serial number (ICCID), printed on the card.',
  freq: 'Centre frequency the tower transmits on, worked out from the band and channel number.',
  bw: 'Width of the LTE carrier. Wider carriers carry more data: 20 MHz is the most a single LTE carrier uses.',
  pci:
    'Physical cell id (0–503): the short number the modem decodes from the radio signal before it reads the ' +
    'full cell id. Neighbouring cells always have different ones.',
  mode: 'Which networks the modem may use. Automatic picks LTE where available and falls back to GSM.',
  data:
    'Attached means the network has set up a packet data session for the SIM, which mobile data needs. It ' +
    'does not mean data is flowing.',
  apn:
    'Access point: the gateway between the operator’s network and the internet. The tracker asks for ' +
    '\u201cinternet\u201d and the network reports the full name it granted.',
  dns: 'Name servers the operator hands out for looking up addresses such as firebaseio.com over mobile data.',
  number: 'The SIM\u2019s phone number, if the operator stored it on the card. Many SIMs leave it empty.',
  spn: 'Operator name stored on the SIM, which can differ from the network it is using (when roaming).',
  sms: 'Text messages waiting in the SIM\u2019s memory. The tracker does not read or send SMS.',
  smsc: 'The operator\u2019s SMS centre that would relay outgoing texts.',
  psm:
    'Power saving mode lets the modem sleep for long periods while staying registered. Off: it stays ' +
    'reachable, which uses more battery.',
  imsi:
    'International mobile subscriber identity: the subscription id stored on the SIM. The first digits are ' +
    'the country and operator (MCC-MNC).',
};

function renderCell() {
  const c = status?.cell;
  const noSim = !!c?.sim && c.sim !== 'ready';
  const lte = c?.sys === 'LTE';
  const signal =
    lte && c?.rsrp != null
      ? `${rsrpQuality(c.rsrp)} (RSRP ${c.rsrp.toFixed(0)} dBm)`
      : c?.rssi != null
        ? `${gsmQuality(c.rssi)} (${c.rssi.toFixed(0)} dBm)`
        : c?.csq != null
          ? `${c.csq} dBm`
          : undefined;
  const registered = c?.reg === 1 || c?.reg === 5;
  $('cell-summary').textContent = !c
    ? '–'
    : noSim
      ? 'No SIM card'
      : registered
        ? [c.op, c.sys, signal?.split(' (')[0]].filter(Boolean).join(' · ')
        : REG_NAMES[c.reg ?? 4] ?? '–';
  const sys = c?.sys === 'NO SERVICE' ? 'No service' : c?.sys;
  const freq = lte ? lteFrequency(c?.band, c?.channel) : undefined;
  const data = c?.attached == null ? undefined : c.attached ? 'Attached' : 'Not attached';
  const enb = lte && c?.cellId != null ? ` (base station ${c.cellId >> 8}, sector ${c.cellId & 255})` : '';
  setRows('cell-rows', [
    ['Status', c?.reg != null ? REG_NAMES[c.reg] ?? String(c.reg) : undefined, CELL_HELP.status],
    ['SIM', c?.sim ? SIM_NAMES[c.sim] ?? c.sim : undefined, CELL_HELP.sim],
    ['Operator', c?.op],
    ['Network', sys, CELL_HELP.network],
    ['MCC-MNC', c?.mccmnc, CELL_HELP.code],
    ['Signal', signal, CELL_HELP.signal],
    ['RSRQ', c?.rsrq != null ? `${c.rsrq.toFixed(1)} dB` : undefined, CELL_HELP.rsrq],
    ['SINR', c?.sinr != null ? `${c.sinr} dB` : undefined, CELL_HELP.sinr],
    ['RSSI', lte && c?.rssi != null ? `${c.rssi.toFixed(0)} dBm` : undefined, CELL_HELP.rssi],
    ['Band', c?.band?.replace('EUTRAN-BAND', 'LTE band '), CELL_HELP.band],
    ['Frequency', freq, CELL_HELP.freq],
    ['Bandwidth', c?.bw != null ? `${c.bw / 1000} MHz` : undefined, CELL_HELP.bw],
    ['Channel', c?.channel != null ? String(c.channel) : undefined, CELL_HELP.channel],
    ['Cell', c?.cellId != null ? `${c.cellId}${enb}${c.area ? `, area ${c.area}` : ''}` : undefined, CELL_HELP.cell],
    ['Physical cell id', c?.pci != null ? String(c.pci) : undefined, CELL_HELP.pci],
    ['Network mode', c?.mode != null ? MODE_NAMES[c.mode] ?? `Mode ${c.mode}` : undefined, CELL_HELP.mode],
    ['Mobile data', data, CELL_HELP.data],
    ['APN', c?.apn, CELL_HELP.apn],
    ['DNS servers', [c?.dns1, c?.dns2].filter(Boolean).join(', ') || undefined, CELL_HELP.dns],
    ['Phone number', c?.number, CELL_HELP.number],
    ['SIM operator', c?.spn, CELL_HELP.spn],
    ['SMS', c?.smsTotal != null ? `${c.smsUsed ?? 0} of ${c.smsTotal} stored on the SIM` : undefined, CELL_HELP.sms],
    ['SMS centre', c?.smsc, CELL_HELP.smsc],
    ['Power saving', c?.psm != null ? (c.psm ? 'On (PSM)' : 'Off') : undefined, CELL_HELP.psm],
    ['Modem temperature', c?.temp != null ? `${c.temp} °C` : undefined, CELL_HELP.temp],
    ['Modem', c?.model ? [c.model, c.fw].filter(Boolean).join(' · ') : undefined],
    ['IMEI', c?.imei, CELL_HELP.imei],
    ['IMSI', c?.imsi, CELL_HELP.imsi],
    ['SIM number', c?.iccid, CELL_HELP.iccid],
  ]);
}

const MODE_NAMES: Record<number, string> = { 2: 'Automatic', 13: 'GSM only', 38: 'LTE only', 51: 'GSM and LTE' };

// LTE downlink carrier frequency from band + EARFCN (3GPP TS 36.101):
// F = F_low + 0.1 × (EARFCN − N_offset).
const LTE_BANDS: Record<number, [fLow: number, nOffs: number]> = {
  1: [2110, 0], 3: [1805, 1200], 7: [2620, 2750], 8: [925, 3450],
  20: [791, 6150], 28: [758, 9210], 38: [2570, 37750], 40: [2300, 38650],
};
function lteFrequency(band?: string, earfcn?: number): string | undefined {
  const n = Number(band?.match(/BAND(\d+)/)?.[1]);
  const b = LTE_BANDS[n];
  if (!b || earfcn == null) return undefined;
  return `${(b[0] + 0.1 * (earfcn - b[1])).toFixed(1)} MHz (downlink)`;
}

// Collapse the whole panel to its header and status line (per browser).
{
  const panel = $('panel');
  const btn = $('panel-toggle');
  const apply = (collapsed: boolean) => {
    panel.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Show details' : 'Hide details';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };
  let collapsed = false;
  try {
    collapsed = localStorage.getItem('panel') === 'collapsed';
  } catch {
    /* storage blocked */
  }
  apply(collapsed);
  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    apply(collapsed);
    try {
      localStorage.setItem('panel', collapsed ? 'collapsed' : 'open');
    } catch {
      /* storage blocked */
    }
  });
}

// Remember which sections are expanded (per browser).
for (const id of ['net-details', 'cell-details', 'gps-details', 'dev-details']) {
  const el = $<HTMLDetailsElement>(id);
  try {
    el.open = localStorage.getItem(id) === 'open';
  } catch {
    /* storage blocked */
  }
  el.addEventListener('toggle', () => {
    try {
      localStorage.setItem(id, el.open ? 'open' : 'closed');
    } catch {
      /* storage blocked */
    }
  });
}

function updateMarker(f: Fix | undefined, fresh: Freshness) {
  if (!map) return;
  if (!f) {
    marker?.remove();
    marker = undefined;
    return;
  }
  if (!marker) {
    pinEl = document.createElement('div');
    pinEl.append(document.createElement('span'));
    marker = new maplibregl.Marker({ element: pinEl }).setLngLat([f.lon, f.lat]).addTo(map);
  } else {
    marker.setLngLat([f.lon, f.lat]);
  }
  pinEl!.className = `pin ${fresh}`;

  if (!centeredOnce) {
    centeredOnce = true;
    map.jumpTo({ center: [f.lon, f.lat], zoom: 16 });
  }
}

$('center').addEventListener('click', () => {
  if (latest && map) {
    map.easeTo({ center: [latest.lon, latest.lat], zoom: Math.max(map.getZoom(), 16) });
  }
});

$('coords').addEventListener('click', async () => {
  if (!latest) return;
  const btn = $('coords');
  const text = `${latest.lat.toFixed(6)}, ${latest.lon.toFixed(6)}`;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
    setTimeout(render, 1200);
  } catch {
    // Clipboard blocked; leave the text visible so it can be selected.
  }
});

function formatAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

// On phones the panel is a bottom sheet: lift the map's bottom controls
// (attribution) above it, and centre the map in the area left visible.
const isSheet = window.matchMedia('(max-width: 640px)');
let sheetHeight = 0;
function applyMapPadding() {
  map?.setPadding({ top: 0, left: 0, right: 0, bottom: isSheet.matches ? sheetHeight : 0 });
}
new ResizeObserver(([entry]) => {
  sheetHeight = entry.borderBoxSize[0].blockSize;
  $('app').style.setProperty('--sheet-h', `${sheetHeight}px`);
  applyMapPadding();
}).observe(document.querySelector('.panel')!);
isSheet.addEventListener('change', applyMapPadding);

// Keep "x min ago" and the freshness colour current.
setInterval(() => {
  if (deviceId) render();
}, 30_000);


