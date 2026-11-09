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
}
