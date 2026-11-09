import 'leaflet/dist/leaflet.css';
import './style.css';

import L from 'leaflet';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { onValue, ref, type Unsubscribe } from 'firebase/database';
import { auth, db } from './firebase';
import type { Fix } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- auth ----------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await signInWithEmailAndPassword(
      auth,
      $<HTMLInputElement>('email').value,
      $<HTMLInputElement>('password').value,
    );
  } catch (err) {
    $('login-error').textContent = (err as Error).message;
  }
});
$('logout').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  $('login').hidden = !!user;
  $('app').hidden = !user;
  if (user) {
    startMap();
  } else {
    stopMap();
  }
});

// ---------- map ----------

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

interface DeviceView {
  marker: L.CircleMarker;
  color: string;
  latest?: Fix;
  unsubLatest?: Unsubscribe;
}

let map: L.Map | undefined;
let unsubDevices: Unsubscribe | undefined;
const devices = new Map<string, DeviceView>();
let selected: string | undefined;
let fittedOnce = false;

function startMap() {
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([49.84, 24.03], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
  }
  // invalidateSize: the container was hidden while Leaflet initialised.
  setTimeout(() => map?.invalidateSize(), 0);

  // The registered devices are the keys of /deviceWriters; per device we watch `latest`.
  unsubDevices = onValue(ref(db, 'deviceWriters'), (snap) => {
    const ids = new Set<string>();
    snap.forEach((child) => {
      ids.add(child.key!);
    });
    for (const id of ids) {
      if (!devices.has(id)) addDevice(id);
    }
    for (const id of [...devices.keys()]) {
      if (!ids.has(id)) removeDevice(id);
    }
    renderList();
  });
}

function stopMap() {
  unsubDevices?.();
  unsubDevices = undefined;
  for (const id of [...devices.keys()]) removeDevice(id);
  renderList();
  fittedOnce = false;
}

function addDevice(id: string) {
  const color = COLORS[devices.size % COLORS.length];
  const d: DeviceView = {
    color,
    marker: L.circleMarker([0, 0], {
      radius: 8,
      color: '#fff',
      weight: 2,
      fillColor: color,
      fillOpacity: 1,
    }),
  };
  d.marker.on('click', () => select(id));
  devices.set(id, d);

  d.unsubLatest = onValue(ref(db, `devices/${id}/latest`), (snap) => {
    const latest = snap.val() as Fix | null;
    d.latest = latest ?? undefined;
    if (latest) {
      d.marker.setLatLng([latest.lat, latest.lon]).addTo(map!);
      d.marker.bindTooltip(`${id}<br>${new Date(latest.ts).toLocaleString()}`);
    }
    renderList();
    if (!fittedOnce) fitAll();
  });
}

function removeDevice(id: string) {
  const d = devices.get(id);
  if (!d) return;
  d.unsubLatest?.();
  d.marker.remove();
  devices.delete(id);
}

function select(id: string) {
  selected = id;
  const d = devices.get(id);
  if (d?.latest) map!.setView([d.latest.lat, d.latest.lon], Math.max(map!.getZoom(), 15));
  renderList();
}

function fitAll() {
  const pts = [...devices.values()]
    .filter((d) => d.latest)
    .map((d) => [d.latest!.lat, d.latest!.lon] as L.LatLngTuple);
  if (pts.length === 0) return;
  fittedOnce = true;
  if (pts.length === 1) map!.setView(pts[0], 15);
  else map!.fitBounds(pts, { padding: [40, 40] });
}

// ---------- sidebar ----------

function renderList() {
  const ul = $('devices');
  ul.replaceChildren();
  if (devices.size === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No devices yet. Waiting for the first fix…';
    ul.append(li);
    return;
  }
  for (const [id, d] of devices) {
    const li = document.createElement('li');
    li.className = id === selected ? 'device selected' : 'device';
    li.onclick = () => select(id);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = d.color;

    const body = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = id;
    const meta = document.createElement('small');
    const f = d.latest;
    meta.textContent = f
      ? `${formatAgo(f.ts)} · ${f.speed?.toFixed(0) ?? 0} km/h · ${f.sats ?? '?'} sats`
      : 'no fix yet';
    const coords = document.createElement('small');
    coords.textContent = f ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : '';
    body.append(name, meta, coords);

    li.append(dot, body);
    ul.append(li);
  }
}

function formatAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

// Refresh "x min ago" labels.
setInterval(renderList, 30_000);
