// Shapes written by the firmware (firmware/main/firebase.c) under /devices/<id>.

export type Constellation = 'gps' | 'glonass' | 'beidou' | 'galileo';

export interface Satellites {
  sats?: number; // used in the fix
  snrAvg?: number; // dB-Hz
  snrMax?: number;
  inView?: Partial<Record<Constellation, number>>;
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

// /devices/<id>/status: live health, written every report cycle.
export interface Status {
  receivedAt: number; // server time, epoch ms
  gps: Satellites & { state: 'fix' | 'searching' | 'no-data' };
  net?: Net;
  device?: Device;
}
