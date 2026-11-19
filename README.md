# Cullary

App desktop per Windows in stile Discord: account, canali con chat e chiamate (2–5 persone) in cui puoi condividere:

- 🖥 **Schermo**: video + audio di sistema (escluso l'audio di Cullary, così gli altri non sentono l'eco delle loro voci)
- 🪟 **App (video + audio)**: una sola finestra e solo l'audio di quell'applicazione
- 🔈 **Solo audio app**: solo l'audio di un'applicazione, senza video
- 📷 **Webcam** e 🎙 **microfono**

L'audio per singola applicazione usa le API WASAPI *process loopback* (Windows 10 2004 o successivo).

## Struttura

| Cartella | Cosa contiene |
|---|---|
| `server/` | Server Node (WebSocket + SQLite): account, canali, chat, signaling WebRTC |
| `app/` | Client Electron: interfaccia e WebRTC peer-to-peer |
| `native/` | `apploopback.exe`, un helper C++ che cattura l'audio di un processo |

## Avvio

Requisiti: Node 22.13 o superiore e Visual Studio con gli strumenti C++ (serve solo per compilare l'helper).

```bash
cd server && npm install && npm start
```

```bash
native\build.bat
```

```bash
cd app && npm install && npm start
```

Al primo avvio scegli **Registrati**. Il server di default è `ws://localhost:3000`.

## Invitare gli amici

1. Metti [`cloudflared.exe`](https://github.com/cloudflare/cloudflared/releases) in `server\bin\`. Il server avvia da solo un tunnel Cloudflare gratuito e cifrato: non serve né account né configurare il router.
2. Con `npm start` il server stampa il **codice invito** (`wss://….trycloudflare.com`) e lo copia negli appunti. Nell'app puoi copiarlo anche con **📨 Invita amici**.
3. Crea l'eseguibile da mandare agli amici con `cd app && npm run dist`, che produce `app\dist\Cullary.exe`, portatile e senza installazione.
4. Gli amici aprono `Cullary.exe`, incollano il codice nel campo "Server" e scelgono **Registrati**.

Il codice cambia a ogni riavvio del server, quindi dopo un riavvio va rimandato. Se vuoi un indirizzo fisso, serve un dominio tuo con un tunnel Cloudflare "named".

`Cullary.exe` non è firmato, quindi Windows SmartScreen mostra un avviso: si apre con "Ulteriori informazioni" → "Esegui comunque".

Con `TUNNEL=0` il server resta raggiungibile solo in rete locale.

Le chiamate sono peer-to-peer con il solo STUN di Google. Su alcune reti (NAT simmetrici, rete mobile, reti aziendali) serve un server TURN, che per ora non c'è.
