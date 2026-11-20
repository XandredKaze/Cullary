# Cullary

App desktop per Windows in stile Discord: account, canali con chat e chiamate (2–5 persone) in cui puoi condividere:

- 🖥 **Schermo**: video + audio di sistema (escluso l'audio di Cullary, così gli altri non sentono l'eco delle loro voci)
- 🪟 **App (video + audio)**: una sola finestra e solo l'audio di quell'applicazione
- 🔈 **Solo audio app**: solo l'audio di un'applicazione, senza video
- 📷 **Webcam** e 🎙 **microfono**

L'audio per singola applicazione usa le API WASAPI *process loopback* (Windows 10 2004 o successivo).

## Per gli amici

Installano `Cullary-Setup.exe`, aprono Cullary e scelgono **Registrati**. Non serve configurare nulla: il server è sempre online su Cloudflare.

L'installer non è firmato, quindi Windows SmartScreen mostra un avviso: si apre con "Ulteriori informazioni" → "Esegui comunque".

## Struttura

| Cartella | Cosa contiene |
|---|---|
| `server/` | Cloudflare Worker + Durable Object (SQLite): account, canali, chat, signaling WebRTC, credenziali TURN |
| `app/` | Client Electron: interfaccia e WebRTC peer-to-peer |
| `native/` | `apploopback.exe`, un helper C++ che cattura l'audio di un processo |

Il server pubblicato è `wss://cullary.cullary-server.workers.dev` ed è scritto nell'app in `app/renderer.js`.

## Sviluppo

Requisiti: Node 22 o superiore e Visual Studio con gli strumenti C++ (serve solo per compilare l'helper).

```bash
native\build.bat
```

```bash
cd server && npm install && npm run dev
```

```bash
cd app && npm install && npm start
```

Per far usare all'app il server locale, nella console di DevTools (Ctrl+Shift+I) esegui `localStorage.devServer = 'ws://localhost:8787'` e ricarica. Per tornare al server vero, cancella la chiave.

## Pubblicare

- Server: `cd server && npm run deploy`. La prima volta serve `npx wrangler login`.
- Installer: `cd app && npm run dist`, che produce `app\dist\Cullary-Setup.exe`.

## TURN (per chi non riesce a collegarsi direttamente)

Le chiamate sono peer-to-peer. Su alcune reti (NAT simmetrici, rete mobile, reti aziendali) il traffico deve passare da un relay TURN. Cullary usa il TURN di Cloudflare: i primi 1.000 GB al mese sono gratis, poi costa 0,05 $/GB.

1. Su dash.cloudflare.com vai in **Realtime → TURN Server → Create**.
2. Crea `server\.env` (è escluso da git) con:
   ```
   TURN_KEY_ID=<Turn Token ID>
   TURN_KEY_API_TOKEN=<API Token>
   ```
   `npm run dev` lo legge in automatico.
3. Carica le chiavi sul Worker pubblicato con `cd server && npx wrangler secret bulk .env`.

Senza chiavi il server funziona lo stesso, ma solo con connessioni dirette (STUN).
