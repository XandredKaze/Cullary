// Cullary server su Cloudflare: un Worker che inoltra tutte le WebSocket a un unico Durable Object ("hub")
// con account, canali, chat (SQLite) e signaling WebRTC. Sempre online, indirizzo fisso *.workers.dev.
import { DurableObject } from 'cloudflare:workers';

export default {
  fetch(req, env) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Cullary server attivo');
    return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
  },
};

const NAME = /^[\p{L}\p{N}._-]{2,24}$/u;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function hash(pass, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  // 100k è il massimo di iterazioni PBKDF2 consentito dai Workers
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100_000 }, key, 256);
  return hex(bits);
}
const sameHash = (a, b) => a.length === b.length && crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY COLLATE NOCASE, hash TEXT, salt TEXT);
      CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS channels(name TEXT PRIMARY KEY COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, channel TEXT, user TEXT, text TEXT, ts INTEGER);
      INSERT OR IGNORE INTO channels VALUES('generale');`);
    // profilo (aggiunto dopo): colonne create al primo avvio, l'errore significa che esistono già
    for (const col of ['nick', 'avatar', 'border']) try { this.sql.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`); } catch {}
  }

  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server); // API "hibernation": il DO può dormire tra un messaggio e l'altro
    return new Response(null, { status: 101, webSocket: client });
  }

  // lo stato di ogni connessione (nome, canale vocale) sta nell'attachment, così sopravvive all'ibernazione
  sockets() {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN)
      .map(ws => ({ ws, ...ws.deserializeAttachment() })).filter(s => s.name);
  }
  patch(ws, p) { try { ws.serializeAttachment({ ...ws.deserializeAttachment(), ...p }); } catch {} }
  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch {} }
  broadcast(m) { for (const s of this.sockets()) this.send(s.ws, m); }
  state() {
    const all = this.sockets();
    this.broadcast({ t: 'state', online: all.map(s => s.name), voice: Object.fromEntries(all.filter(s => s.voice).map(s => [s.name, s.voice])) });
  }
  row(q, ...args) { return this.sql.exec(q, ...args).toArray()[0]; }
  // ponytail: manda tutti i profili a ogni login (avatar ~10 KB l'uno), va bene per un gruppo di amici
  profiles() {
    return Object.fromEntries(this.sql.exec('SELECT name, nick, avatar, border FROM users').toArray()
      .map(r => [r.name, { nick: r.nick, avatar: r.avatar, border: r.border }]));
  }
  channelList() { return this.sql.exec('SELECT name FROM channels ORDER BY name').toArray().map(r => r.name); }

  async login(m) {
    if (m.t === 'auth') {
      const r = this.row('SELECT name FROM tokens WHERE token = ?', String(m.token));
      if (!r) throw 'Sessione scaduta, accedi di nuovo';
      return r.name;
    }
    const name = String(m.user ?? ''), pass = String(m.pass ?? '');
    if (m.t === 'register') {
      if (!NAME.test(name)) throw 'Nome: 2-24 caratteri tra lettere, numeri, . _ -';
      if (pass.length < 6) throw 'Password di almeno 6 caratteri';
      if (this.row('SELECT name FROM users WHERE name = ?', name)) throw 'Nome già in uso';
      const salt = randHex(16);
      this.sql.exec('INSERT INTO users (name, hash, salt) VALUES (?, ?, ?)', name, await hash(pass, salt), salt);
      return name;
    }
    if (m.t === 'login') {
      const u = this.row('SELECT * FROM users WHERE name = ?', name);
      if (!u || !sameHash(await hash(pass, u.salt), u.hash)) throw 'Utente o password errati';
      return u.name;
    }
    throw 'Non autenticato';
  }

  // TURN Cloudflare: credenziali temporanee per chi non riesce a collegarsi direttamente.
  // ponytail: una credenziale da 24 h condivisa, rigenerata ogni 12 h (cache in memoria, si perde se il DO dorme: va bene)
  async ice() {
    const { TURN_KEY_ID: id, TURN_KEY_API_TOKEN: token } = this.env;
    if (!id || !token) return null;
    if (this.iceCache && Date.now() - this.iceAt < 12 * 3600e3) return this.iceCache;
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // la porta 53 viene bloccata dai browser: la togliamo
      this.iceCache = (await r.json()).iceServers.map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53\b/.test(u)) }));
      this.iceAt = Date.now();
    } catch (e) { console.error('TURN non disponibile:', e.message); }
    return this.iceCache ?? null;
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const me = ws.deserializeAttachment()?.name;

    if (!me) {
      let name;
      try { name = await this.login(m); } catch (text) { return this.send(ws, { t: 'error', text: String(text), auth: true }); }
      const token = m.t === 'auth' ? String(m.token) : randHex(24);
      if (m.t !== 'auth') this.sql.exec('INSERT INTO tokens VALUES (?, ?)', token, name);
      for (const s of this.sockets()) if (s.name === name) { this.patch(s.ws, { name: null, voice: null }); s.ws.close(4000, 'Accesso da un altro dispositivo'); }
      const ice = await this.ice();
      ws.serializeAttachment({ name });
      this.send(ws, { t: 'ready', user: name, token, channels: this.channelList(), profiles: this.profiles(), ice });
      return this.state();
    }

    switch (m.t) {
      case 'logout':
        this.sql.exec('DELETE FROM tokens WHERE token = ?', String(m.token));
        return ws.close(1000, 'logout');
      case 'history': {
        const channel = String(m.channel);
        const messages = this.sql.exec('SELECT * FROM (SELECT * FROM messages WHERE channel = ? ORDER BY id DESC LIMIT 100) ORDER BY id', channel).toArray();
        return this.send(ws, { t: 'history', channel, messages });
      }
      case 'msg': {
        const text = String(m.text ?? '').trim(), channel = String(m.channel);
        if (!text || text.length > 2000 || !this.row('SELECT name FROM channels WHERE name = ?', channel)) return;
        const ts = Date.now();
        const { id } = this.row('INSERT INTO messages (channel, user, text, ts) VALUES (?, ?, ?, ?) RETURNING id', channel, me, text, ts);
        return this.broadcast({ t: 'msg', id, channel, user: me, text, ts });
      }
      case 'create_channel': {
        const name = String(m.name ?? '').trim();
        if (!NAME.test(name)) return this.send(ws, { t: 'error', text: 'Nome canale: 2-24 caratteri tra lettere, numeri, . _ -' });
        this.sql.exec('INSERT OR IGNORE INTO channels VALUES (?)', name);
        return this.broadcast({ t: 'channels', channels: this.channelList() });
      }
      case 'join_voice': {
        const c = this.row('SELECT name FROM channels WHERE name = ?', String(m.channel));
        if (!c) return;
        this.patch(ws, { voice: c.name });
        return this.state();
      }
      case 'profile': {
        const nick = String(m.nick ?? '').replace(/\p{C}/gu, '').trim().slice(0, 32) || null;
        const avatar = typeof m.avatar === 'string' && m.avatar.length <= 100_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(m.avatar) ? m.avatar : null;
        const border = /^#[0-9a-f]{6}\|(none|solid|glow|double)$/i.test(m.border) ? m.border : null;
        this.sql.exec('UPDATE users SET nick = ?, avatar = ?, border = ? WHERE name = ?', nick, avatar, border, me);
        return this.broadcast({ t: 'profile', user: me, profile: { nick, avatar, border } });
      }
      case 'leave_voice':
        this.patch(ws, { voice: null });
        return this.state();
      case 'signal': {
        // inoltra offerte/risposte/ICE solo tra utenti nella stessa chiamata
        const mine = ws.deserializeAttachment().voice;
        const to = this.sockets().find(s => s.name === String(m.to));
        if (mine && to?.voice === mine) this.send(to.ws, { t: 'signal', from: me, data: m.data });
        return;
      }
    }
  }

  webSocketClose(ws) {
    this.patch(ws, { name: null, voice: null });
    try { ws.close(); } catch {}
    this.state();
  }
  webSocketError(ws) { this.webSocketClose(ws); }
}
