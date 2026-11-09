import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { onValue, ref, type Unsubscribe } from 'firebase/database';
import { auth, db } from './firebase';
import type { Fix } from './types';

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
let centeredOnce = false;
const unsubs: Unsubscribe[] = [];
let unsubLatest: Unsubscribe | undefined;

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
  unsubLatest?.();
  unsubLatest = undefined;
  deviceId = id;
  latest = undefined;
  centeredOnce = false;
  if (id) {
    unsubLatest = onValue(ref(db, `devices/${id}/latest`), (snap) => {
      latest = (snap.val() as Fix | null) ?? undefined;
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

type Freshness = 'live' | 'recent' | 'stale' | 'none';

function freshness(f?: Fix): Freshness {
  if (!f) return 'none';
  const age = Date.now() - f.ts;
  if (age < 2 * 60_000) return 'live';
  if (age < 15 * 60_000) return 'recent';
  return 'stale';
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
  const fresh = freshness(f);

  $('device-name').textContent = deviceId ?? 'No tracker';
  $('status-dot').className = `status-dot ${fresh}`;
  $('status-text').textContent = !deviceId
    ? 'No tracker is registered yet.'
    : !f
      ? 'Waiting for the first GPS fix…'
      : fresh === 'live'
        ? `Live · updated ${formatAgo(f.ts)}`
        : `Last seen ${formatAgo(f.ts)}`;

  $('stat-speed').textContent = f ? `${Math.round(f.speed ?? 0)} km/h` : '–';
  $('stat-sats').textContent = f?.sats != null ? String(f.sats) : '–';
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

  updateMarker(f, fresh);
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

// On phones the panel is a bottom sheet; lift the map's bottom controls
// (attribution) above it.
new ResizeObserver(([entry]) => {
  $('app').style.setProperty('--sheet-h', `${entry.borderBoxSize[0].blockSize}px`);
}).observe(document.querySelector('.panel')!);

// Keep "x min ago" and the freshness colour current.
setInterval(() => {
  if (deviceId) render();
}, 30_000);
