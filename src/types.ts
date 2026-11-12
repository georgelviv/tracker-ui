// Shapes written by the firmware (firmware/main/firebase.c) under /devices/<id>.

export type Constellation = 'gps' | 'glonass' | 'beidou' | 'galileo';

// One satellite the receiver can see.
export interface Sat {
  sys: Constellation;
  prn: number; // satellite number within its constellation
  el?: number; // elevation above the horizon, degrees (0 horizon, 90 overhead)
  az?: number; // azimuth from true north, degrees
  snr?: number; // C/N0, dB-Hz; missing when not being tracked
  used?: boolean; // part of the position calculation
}

export interface Satellites {
  sats?: number; // used in the fix
  snrAvg?: number; // dB-Hz
  snrMax?: number;
  inView?: Partial<Record<Constellation, number>>;
}

// Receiver details sent with every check-in (status.gps).
export interface Receiver {
  sky?: Sat[];
  ttff?: number; // s from power-on to the first fix
  clock?: number; // receiver UTC clock, epoch ms (known even without a fix)
  mode?: 'A' | 'D' | 'E' | 'N' | string; // autonomous / differential / estimated / none
  antenna?: string; // OK / OPEN / SHORT
  err?: { lat: number; lon: number; alt: number }; // 1-sigma error estimate, m
}

export interface Net {
  type: 'wifi' | 'lte';
  name?: string; // SSID or operator
  rssi?: number; // dBm
  channel?: number;
  ip?: string;
}

export interface Device {
  uptime?: number; // s
  fw?: string;
  battery?: number; // mV
  reset?: string; // why the board last restarted
  boots?: number;
  brownouts?: number;
  // What the run before the current boot got done (saved on the board).
  prev?: {
    boot: number;
    uptime: number; // s
    uploads: number;
    failures: number;
    noFix: number;
    minBattery?: number; // mV
  };
}

// /devices/<id>/latest: last known position, written only with a GPS fix.
export interface Fix {
  lat: number;
  lon: number;
  alt?: number;
  speed?: number; // km/h
  course?: number; // degrees
  hdop?: number;
  sats?: number;
  ts: number; // GNSS UTC time, epoch ms
  receivedAt?: number; // server time, epoch ms
  via?: 'wifi' | 'lte' | 'sms';
  gps?: Satellites & {
    quality?: number; // 0 none, 1 GPS, 2 DGPS, 6 estimated
    fixType?: number; // 1 none, 2 = 2D, 3 = 3D
    pdop?: number;
    vdop?: number;
    geoid?: number; // m
  };
  // Older firmware put these here; newer firmware sends them in Status.
  net?: Net;
  device?: Device;
}

// Mobile modem (A7670), SIM and the serving cell tower.
export interface Cell {
  model?: string;
  fw?: string;
  imei?: string;
  sim?: string; // ready / SIM not inserted / SIM PIN / ...
  iccid?: string; // SIM card number
  reg?: number; // 0 not searching, 1 home, 2 searching, 3 denied, 4 unknown, 5 roaming
  op?: string; // operator name
  csq?: number; // signal, dBm (AT+CSQ)
  temp?: number; // modem temperature, °C
  sys?: string; // LTE / GSM / NO SERVICE
  mccmnc?: string; // e.g. 255-03
  area?: string; // TAC (LTE) / LAC (GSM), hex
  cellId?: number;
  band?: string;
  channel?: number; // EARFCN / ARFCN
  rsrp?: number; // dBm
  rsrq?: number; // dB
  rssi?: number; // dBm
  sinr?: number; // dB
}

// /devices/<id>/status: live health, written every report cycle.
export interface Status {
  receivedAt: number; // server time, epoch ms
  gps: Satellites & Receiver & { state: 'fix' | 'searching' | 'no-data' };
  net?: Net;
  cell?: Cell;
  device?: Device;
}
