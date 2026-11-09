# Tracker UI

Web map for the tracker: Vite + TypeScript + Leaflet (OpenStreetMap tiles), Firebase Auth + Realtime Database,
hosted on Firebase Hosting.

It shows each device's latest position live, plus its track for the last 1 h, 24 h or 7 days.

## One-time Firebase setup

1. Create a Firebase project. In it:
   - **Build → Realtime Database**: create a database (locked mode).
   - **Build → Authentication → Sign-in method**: enable **Email/Password**.
   - **Project settings → Your apps**: add a **Web app** and copy its config.
2. In **Authentication → Users**, add two users:
   - you (for the web UI)
   - the device, e.g. `tracker-01@yourdomain.dev`, with a strong password
3. In the **Realtime Database data** tab, add:
   ```
   admins/<your UID>            = true
   deviceWriters/tracker-01     = "<device UID>"
   ```
4. Link this folder and deploy the rules:
   ```bash
   firebase login
   firebase use --add
   firebase deploy --only database
   ```

## Access rules (`database.rules.json`)

- Only users listed in `/admins` can read `/devices`.
- A device can write only to `/devices/<its id>`, and only if `/deviceWriters/<id>` holds its UID.
- Nobody can write `/admins` or `/deviceWriters` from a client. Edit them in the console.

## Develop

```bash
cp .env.example .env.local   # fill in the web app config
npm install
npm run dev
```

## Deploy

```bash
npm run deploy   # builds, then deploys hosting + database rules
```
