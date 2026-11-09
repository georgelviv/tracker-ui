# Stezhka UI

**Live: https://stezhka-tracker.web.app/**

Web map for the Stezhka GPS tracker: Vite + TypeScript + Leaflet (OpenStreetMap tiles), Firebase Auth +
Realtime Database, hosted on Firebase Hosting.

It shows each device's latest position live. Only the newest point is stored; there is no history yet.

Firebase project: `stezhka-tracker` ([console](https://console.firebase.google.com/project/stezhka-tracker/overview)).

## One-time Firebase setup

The project and the web app already exist. The remaining steps are in the console:

1. **Build → Realtime Database → Create database**. Pick **Belgium (europe-west1)** and **locked mode**.
   The UI expects `https://stezhka-tracker-default-rtdb.europe-west1.firebasedatabase.app`.
2. **Build → Authentication → Sign-in method**: enable **Email/Password**.
3. **Authentication → Users**, add two users:
   - you, for the web UI
   - the device, e.g. `tracker-01@stezhka.dev`, with a strong password
4. In the **Realtime Database data** tab, add:
   ```
   admins/<your UID>            = true
   deviceWriters/tracker-01     = "<device UID>"
   ```
5. Deploy the rules:
   ```bash
   firebase deploy --only database
   ```

## Access rules (`database.rules.json`)

- Only users listed in `/admins` can read `/devices`.
- A device can write only `/devices/<its id>/latest`, and only if `/deviceWriters/<id>` holds its UID.
- Nobody can write `/admins` or `/deviceWriters` from a client. Edit them in the console.

## Develop

```bash
cp .env.example .env.local   # fill in the web app config: firebase apps:sdkconfig WEB
npm install
npm run dev
```

## Deploy

```bash
npm run deploy   # builds, then deploys hosting + database rules
```

If your Firebase CLI is logged in to more than one Google account, pin the right one for this folder first:

```bash
firebase login:use <your-account@gmail.com>
```
