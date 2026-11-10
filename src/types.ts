// Shape written by the firmware (firmware/main/firebase.c).
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
  gps?: {
    quality?: number; // 0 none, 1 GPS, 2 DGPS, 6 estimated
    fixType?: number; // 1 none, 2 = 2D, 3 = 3D
    pdop?: number;
    vdop?: number;
    geoid?: number; // m
    snrAvg?: number; // dB-Hz
    snrMax?: number;
    inView?: Partial<Record<'gps' | 'glonass' | 'beidou' | 'galileo', number>>;
  };
  net?: {
    type: 'wifi' | 'lte';
    name?: string; // SSID or operator
    rssi?: number; // dBm
    channel?: number;
    ip?: string;
  };
  device?: {
    uptime?: number; // s
    fw?: string;
    battery?: number; // mV
    reset?: string; // why the board last restarted
    boots?: number;
    brownouts?: number;
  };
}
