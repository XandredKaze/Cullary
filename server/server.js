// Cullary server: account, canali, chat e signaling WebRTC su un'unica WebSocket.
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3000;
const NAME = /^[\p{L}\p{N}._-]{2,24}$/u;

const db = new DatabaseSync(process.env.DB || fileURLToPath(new URL('cullary.db', import.meta.url)));
db.exec(`
  CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY COLLATE NOCASE, hash BLOB, salt BLOB);
  CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS channels(name TEXT PRIMARY KEY COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, channel TEXT, user TEXT, text TEXT, ts INTEGER);
  INSERT OR IGNORE INTO channels VALUES('generale');
`);
const q = {
  user: db.prepare('SELECT * FROM users WHERE name = ?'),
  addUser: db.prepare('INSERT INTO users VALUES (?, ?, ?)'),
  token: db.prepare('SELECT name FROM tokens WHERE token = ?'),
  addToken: db.prepare('INSERT INTO tokens VALUES (?, ?)'),
  delToken: db.prepare('DELETE FROM tokens WHERE token = ?'),
  channels: db.prepare('SELECT name FROM channels ORDER BY name'),
  channel: db.prepare('SELECT name FROM channels WHERE name = ?'),
  addChannel: db.prepare('INSERT OR IGNORE INTO channels VALUES (?)'),
  history: db.prepare('SELECT * FROM (SELECT * FROM messages WHERE channel = ? ORDER BY id DESC LIMIT 100) ORDER BY id'),
  addMsg: db.prepare('INSERT INTO messages (channel, user, text, ts) VALUES (?, ?, ?, ?)'),
};

const online = new Map(); // nome -> ws
const voice = new Map();  // nome -> canale vocale
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const broadcast = m => online.forEach(ws => send(ws, m));
const channelList = () => q.channels.all().map(r => r.name);
const broadcastState = () => broadcast({ t: 'state', online: [...online.keys()], voice: Object.fromEntries(voice) });

function login(m) {
  if (m.t === 'auth') {
    const r = q.token.get(String(m.token));
    if (!r) throw 'Sessione scaduta, accedi di nuovo';
    return r.name;
  }
  const name = String(m.user ?? ''), pass = String(m.pass ?? '');
  if (m.t === 'register') {
    if (!NAME.test(name)) throw 'Nome: 2-24 caratteri tra lettere, numeri, . _ -';
    if (pass.length < 6) throw 'Password di almeno 6 caratteri';
    const salt = randomBytes(16);
    try { q.addUser.run(name, scryptSync(pass, salt, 32), salt); } catch { throw 'Nome già in uso'; }
    return name;
  }
  if (m.t === 'login') {
    const u = q.user.get(name);
    if (!u || !timingSafeEqual(scryptSync(pass, u.salt, 32), u.hash)) throw 'Utente o password errati';
    return u.name;
  }
  throw 'Non autenticato';
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 256 * 1024 });
wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (!me) {
      try { me = login(m); } catch (text) { return send(ws, { t: 'error', text: String(text), auth: true }); }
      const token = m.t === 'auth' ? m.token : randomBytes(24).toString('hex');
      if (m.t !== 'auth') q.addToken.run(token, me);
      online.get(me)?.close(); // stesso utente da un altro client: vince l'ultimo
      voice.delete(me);
      online.set(me, ws);
      send(ws, { t: 'ready', user: me, token, channels: channelList(), invite });
      return broadcastState();
    }

    switch (m.t) {
      case 'logout':
        q.delToken.run(String(m.token));
        return ws.close();
      case 'history':
        return send(ws, { t: 'history', channel: String(m.channel), messages: q.history.all(String(m.channel)) });
      case 'msg': {
        const text = String(m.text ?? '').trim();
        if (!text || text.length > 2000 || !q.channel.get(String(m.channel))) return;
        const ts = Date.now();
        const { lastInsertRowid } = q.addMsg.run(m.channel, me, text, ts);
        return broadcast({ t: 'msg', id: Number(lastInsertRowid), channel: m.channel, user: me, text, ts });
      }
      case 'create_channel': {
        const name = String(m.name ?? '').trim();
        if (!NAME.test(name)) return send(ws, { t: 'error', text: 'Nome canale: 2-24 caratteri tra lettere, numeri, . _ -' });
        q.addChannel.run(name);
        return broadcast({ t: 'channels', channels: channelList() });
      }
      case 'join_voice':
        if (!q.channel.get(String(m.channel))) return;
        voice.set(me, q.channel.get(String(m.channel)).name);
        return broadcastState();
      case 'leave_voice':
        voice.delete(me);
        return broadcastState();
      case 'signal': {
        // inoltra offerte/risposte/ICE solo tra utenti nella stessa chiamata
        const to = String(m.to);
        if (voice.has(me) && voice.get(to) === voice.get(me)) send(online.get(to), { t: 'signal', from: me, data: m.data });
        return;
      }
    }
  });
  ws.on('close', () => {
    if (!me || online.get(me) !== ws) return;
    online.delete(me);
    voice.delete(me);
    broadcastState();
  });
});
console.log(`Cullary server su ws://0.0.0.0:${PORT}`);

// Tunnel Cloudflare (quick tunnel, senza account): rende il server raggiungibile da internet via wss://
let invite = null;
const CLOUDFLARED = fileURLToPath(new URL('bin/cloudflared.exe', import.meta.url));
if (process.env.TUNNEL !== '0' && existsSync(CLOUDFLARED)) {
  const cf = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
  cf.stderr.on('data', d => {
    const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d)?.[0];
    if (!url || invite) return;
    invite = url.replace('https://', 'wss://');
    console.log(`\nCodice invito (da incollare nel campo "Server" dell'app):\n\n  ${invite}\n`);
    spawn('clip').stdin.end(invite);
    broadcast({ t: 'invite', invite });
  });
  cf.on('exit', code => console.error(`cloudflared terminato (codice ${code}): niente accesso da internet`));
  process.on('exit', () => cf.kill());
  process.on('SIGINT', () => process.exit());
} else console.log('Tunnel disattivato: raggiungibile solo in rete locale');
