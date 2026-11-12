// Sky plot and signal-strength chart for the satellites the receiver sees.
import type { Constellation, Sat } from './types';

export const SYSTEMS: Record<Constellation, { name: string; letter: string }> = {
  gps: { name: 'GPS', letter: 'G' }, // USA
  beidou: { name: 'BeiDou', letter: 'C' }, // China
  glonass: { name: 'GLONASS', letter: 'R' }, // Russia
  galileo: { name: 'Galileo', letter: 'E' }, // EU
};
// Fixed colour slot per constellation (see .sky-* in style.css).
const ORDER: Constellation[] = ['gps', 'beidou', 'glonass', 'galileo'];

// RINEX-style id, e.g. G05 for GPS satellite 5, C07 for BeiDou 7.
export const satId = (s: Sat) => `${SYSTEMS[s.sys]?.letter ?? '?'}${String(s.prn).padStart(2, '0')}`;
const key = (s: Sat) => `${s.sys}:${s.prn}`;

const SVG = 'http://www.w3.org/2000/svg';
function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

function sortSats(sky: Sat[]): Sat[] {
  return [...sky].sort((a, b) => ORDER.indexOf(a.sys) - ORDER.indexOf(b.sys) || a.prn - b.prn);
}

export function describeSat(s: Sat): string {
  // NMEA numbers GLONASS satellites 65-96 (orbit slot + 64).
  const slot = s.sys === 'glonass' && s.prn > 64 ? `, orbit slot ${s.prn - 64}` : '';
  const lines = [`${SYSTEMS[s.sys]?.name ?? s.sys} satellite ${s.prn} (${satId(s)}${slot})`];
  if (s.el != null && s.az != null) lines.push(`${s.el}° above the horizon, bearing ${s.az}°`);
  lines.push(s.snr != null ? `Signal ${s.snr} dB-Hz` : 'Known position, no signal received');
  lines.push(s.used ? 'Used for the position' : s.snr != null ? 'Received, not used' : 'Not used');
  return lines.join('\n');
}

// ---------- tooltip (shared by both charts) ----------

function attachTooltip(figure: HTMLElement, target: Element, s: Sat) {
  const show = (ev: PointerEvent) => {
    let tip = figure.querySelector<HTMLDivElement>('.sky-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'sky-tip';
      figure.append(tip);
    }
    tip.textContent = describeSat(s);
    const box = figure.getBoundingClientRect();
    const x = ev.clientX - box.left;
    const y = ev.clientY - box.top;
    tip.style.left = `${Math.min(Math.max(x, 80), box.width - 80)}px`;
    tip.style.top = `${y}px`;
    tip.hidden = false;
  };
  target.addEventListener('pointerenter', show as EventListener);
  target.addEventListener('pointerdown', show as EventListener);
  target.addEventListener('pointerleave', () => {
    const tip = figure.querySelector<HTMLDivElement>('.sky-tip');
    if (tip) tip.hidden = true;
  });
}

// ---------- satellite tracks (kept in the browser while the page is open) ----------

const tracks = new Map<string, { t: number; el: number; az: number }[]>();
let lastSample = 0;

// Satellites move ~0.5°/min across the sky; record each check-in to draw their paths.
export function recordSky(sky: Sat[] | undefined, at: number) {
  if (!sky || at <= lastSample) return;
  lastSample = at;
  for (const s of sky) {
    if (s.el == null || s.az == null) continue;
    const list = tracks.get(key(s)) ?? [];
    const prev = list[list.length - 1];
    if (!prev || prev.el !== s.el || prev.az !== s.az) list.push({ t: at, el: s.el, az: s.az });
    if (list.length > 300) list.shift();
    tracks.set(key(s), list);
  }
}

// ---------- sky plot ----------

const SIZE = 260;
const C = SIZE / 2;
const R = 104; // horizon radius

// Polar projection: centre = straight up (90°), outer ring = horizon (0°), north up.
function project(elDeg: number, azDeg: number): [number, number] {
  const r = (R * (90 - elDeg)) / 90;
  const a = (azDeg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

export function renderSkyPlot(figure: HTMLElement, sky: Sat[]) {
  const svg = el('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'img', class: 'sky-plot' });
  const placed = sky.filter((s) => s.el != null && s.az != null);
  svg.setAttribute(
    'aria-label',
    `Sky plot: ${placed.length} satellites, ${sky.filter((s) => s.used).length} used for the position`,
  );

  // Grid: horizon, 30° and 60° elevation rings, compass cross.
  const grid = el('g', { class: 'sky-grid' }, svg);
  for (const e of [0, 30, 60]) el('circle', { cx: C, cy: C, r: (R * (90 - e)) / 90 }, grid);
  el('line', { x1: C, y1: C - R, x2: C, y2: C + R }, grid);
  el('line', { x1: C - R, y1: C, x2: C + R, y2: C }, grid);
  const labels = el('g', { class: 'sky-axis' }, svg);
  for (const [t, x, y] of [
    ['N', C, C - R - 8],
    ['E', C + R + 9, C],
    ['S', C, C + R + 9],
    ['W', C - R - 9, C],
  ] as const) {
    el('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, labels).textContent = t;
  }
  for (const e of [30, 60]) {
    const [x, y] = project(e, 180);
    el('text', { x: x + 3, y: y - 3, class: 'sky-ring-label' }, labels).textContent = `${e}°`;
  }

  // Paths travelled since the page was opened.
  const trails = el('g', { class: 'sky-trails' }, svg);
  for (const s of placed) {
    const pts = tracks.get(key(s));
    if (!pts || pts.length < 2) continue;
    el('polyline', { points: pts.map((p) => project(p.el, p.az).join(',')).join(' '), class: `sky-${s.sys}` }, trails);
  }

  // Heard, but the receiver has not decoded where they are yet.
  const unplaced = sky.length - placed.length;
  if (unplaced) {
    el('text', { x: 0, y: SIZE - 2, class: 'sky-ring-label' }, labels).textContent =
      `+${unplaced} not placed yet`;
  }

  // Unused first so used satellites sit on top.
  const marks = el('g', { class: 'sky-marks' }, svg);
  const ordered = [...placed].sort((a, b) => Number(!!a.used) - Number(!!b.used));
  for (const s of ordered) {
    const [x, y] = project(s.el!, s.az!);
    const state = s.used ? 'used' : s.snr != null ? 'heard' : 'silent';
    const g = el('g', { class: `sky-sat sky-${s.sys} ${state}`, tabindex: 0 }, marks);
    el('circle', { cx: x, cy: y, r: 11, class: 'hit' }, g);
    el('circle', { cx: x, cy: y, r: 8, class: 'dot' }, g);
    el('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g).textContent = String(s.prn);
    el('title', {}, g).textContent = describeSat(s);
    attachTooltip(figure, g, s);
  }

  figure.querySelector('svg')?.remove();
  const cap = figure.querySelector("figcaption");
  if (cap) cap.after(svg);
  else figure.prepend(svg);
}

// ---------- signal bars ----------

const BAR_H = 96; // plot height
const SNR_MAX = 50; // dB-Hz at the top of the scale

export function renderSignalBars(figure: HTMLElement, sky: Sat[]) {
  const sats = sortSats(sky).filter((s) => s.snr != null);
  const W = 288;
  const left = 22;
  const top = 6;
  const bottom = 26; // room for satellite ids
  const H = top + BAR_H + bottom;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'sig-plot' });
  svg.setAttribute('aria-label', `Signal strength of ${sats.length} received satellites`);

  const y = (v: number) => top + BAR_H * (1 - Math.min(v, SNR_MAX) / SNR_MAX);
  const grid = el('g', { class: 'sky-grid' }, svg);
  const axis = el('g', { class: 'sky-axis' }, svg);
  for (const v of [0, 10, 20, 30, 40, 50]) {
    el('line', { x1: left, x2: W, y1: y(v), y2: y(v) }, grid);
    el('text', { x: left - 4, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'central' }, axis).textContent =
      String(v);
  }
  // Below ~25 dB-Hz a receiver struggles to decode the satellite's data.
  el('line', { x1: left, x2: W, y1: y(25), y2: y(25), class: 'sig-threshold' }, svg);

  if (!sats.length) {
    el('text', { x: (left + W) / 2, y: top + BAR_H / 2, 'text-anchor': 'middle', class: 'sig-empty' }, svg).textContent =
      'No satellite signals received';
  }
  const slot = (W - left) / Math.max(sats.length, 8);
  const bw = Math.max(Math.min(slot - 2, 16), 3);
  sats.forEach((s, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    const g = el('g', { class: `sig-bar sky-${s.sys} ${s.used ? 'used' : 'heard'}`, tabindex: 0 }, svg);
    el('rect', { x: left + i * slot, y: top, width: slot, height: BAR_H, class: 'hit' }, g);
    const h = Math.max(BAR_H - (y(s.snr!) - top), 1);
    // 4px rounded top, square at the baseline.
    const r = Math.min(4, bw / 2, h);
    const yt = top + BAR_H - h;
    el(
      'path',
      {
        d: `M${x},${top + BAR_H}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${top + BAR_H}Z`,
        class: 'bar',
      },
      g,
    );
    const lx = x + bw / 2;
    const ly = top + BAR_H + 5;
    el('text', { x: lx, y: ly, transform: `rotate(-90 ${lx} ${ly})`, 'text-anchor': 'end', 'dominant-baseline': 'central' }, g)
      .textContent = satId(s);
    el('title', {}, g).textContent = describeSat(s);
    attachTooltip(figure, g, s);
  });

  figure.querySelector('svg')?.remove();
  const cap = figure.querySelector("figcaption");
  if (cap) cap.after(svg);
  else figure.prepend(svg);
}

// Legend: one entry per constellation present, plus what filled / hollow mean.
export function renderLegend(container: HTMLElement, sky: Sat[]) {
  const present = ORDER.filter((c) => sky.some((s) => s.sys === c));
  container.replaceChildren(
    ...present.map((c) => {
      const used = sky.filter((s) => s.sys === c && s.used).length;
      const all = sky.filter((s) => s.sys === c).length;
      const item = document.createElement('span');
      item.className = `legend-item sky-${c}`;
      item.innerHTML = '<i class="swatch"></i>';
      item.append(`${SYSTEMS[c].name} ${used}/${all}`);
      return item;
    }),
  );
}
