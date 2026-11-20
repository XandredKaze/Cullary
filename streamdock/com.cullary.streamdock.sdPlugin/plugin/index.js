// Plugin Stream Dock per Cullary: ogni tasto manda un comando all'app e mostra lo stato della chiamata.
// Parla con Cullary su http://127.0.0.1:47719 (vedi app/main.js, "controllo remoto").
const WebSocket = require('ws');
const http = require('node:http');

const CULLARY = { host: '127.0.0.1', port: 47719 };
const arg = name => process.argv[process.argv.indexOf(name) + 1];

// tasti a due stati: quando sono "accesi" (stato 1)
const ACTIVE = {
  mic: s => s.inCall && !s.mic, // 1 = microfono silenziato
  deafen: s => s.deafened,
  cam: s => s.cam, screen: s => s.screen, app: s => s.app, audio: s => s.audio,
};

const keys = new Map(); // context del tasto -> comando
let state = {};

const sd = new WebSocket('ws://127.0.0.1:' + arg('-port'));
const toHost = msg => sd.readyState === WebSocket.OPEN && sd.send(JSON.stringify(msg));
sd.on('open', () => toHost({ event: arg('-registerEvent'), uuid: arg('-pluginUUID') }));
sd.on('close', () => process.exit());
sd.on('message', raw => {
  const m = JSON.parse(raw);
  const cmd = m.action?.split('.').pop();
  if (m.event === 'willAppear') { keys.set(m.context, cmd); paint(cmd, m.context); }
  else if (m.event === 'willDisappear') keys.delete(m.context);
  else if (m.event === 'keyUp') command(cmd, m.context);
});

function paint(cmd, context) {
  if (ACTIVE[cmd]) toHost({ event: 'setState', context, payload: { state: ACTIVE[cmd](state) ? 1 : 0 } });
}

function command(cmd, context) {
  const fail = () => toHost({ event: 'showAlert', context }); // Cullary chiuso o comando rifiutato
  http.request({ ...CULLARY, path: '/cmd/' + cmd, method: 'POST', headers: { 'X-Cullary': '1' } }, res => {
    res.resume();
    if (res.statusCode !== 204) fail();
  }).on('error', fail).end();
}

// Stato in tempo reale (Server-Sent Events). Se Cullary è chiuso riprova ogni 3 secondi.
function watch() {
  let done = false, buf = '';
  const retry = () => {
    if (done) return;
    done = true;
    state = {};
    keys.forEach(paint);
    setTimeout(watch, 3000);
  };
  http.get({ ...CULLARY, path: '/state' }, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const line = buf.slice(0, i);
        if (line.startsWith('data: ')) { state = JSON.parse(line.slice(6)); keys.forEach(paint); }
      }
    });
    res.on('end', retry).on('error', retry);
  }).on('error', retry);
}
watch();
