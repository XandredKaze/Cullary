const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

let invite = null;
let ws, me = null, current = null, myVoice = null, channels = [], voice = {}, online = [];
const peers = new Map();   // nome -> { pc, polite, makingOffer, ignoreOffer, senders }
const tiles = new Map();   // stream.id -> elemento
const local = {};          // mic | cam | screen | app | audio -> MediaStream
const cleanup = {};        // chiave -> stop dell'audio nativo
const unread = new Set();

// ---------- connessione e login ----------
function connect(first) {
  ws?.close();
  const sock = ws = new WebSocket(localStorage.server);
  sock.onopen = () => send(first);
  sock.onmessage = e => handle(JSON.parse(e.data));
  sock.onerror = () => !me && ($('#login-error').textContent = 'Server non raggiungibile');
  sock.onclose = () => {
    if (sock !== ws || !me) return;
    leaveVoice(true);
    status('Connessione persa, riprovo…');
    setTimeout(() => sock === ws && connect({ t: 'auth', token: localStorage.token }), 2000);
  };
}
const send = m => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function status(text) {
  $('#status').textContent = text;
  clearTimeout(status.t);
  status.t = setTimeout(() => ($('#status').textContent = ''), 6000);
}

// accetta il codice invito (wss://…), un link https://… o un host nudo
function serverUrl(v) {
  v = v.trim().replace(/\/+$/, '').replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  return /^wss?:\/\//.test(v) ? v : (/^(localhost|127\.|192\.168\.|10\.)/.test(v) ? 'ws://' : 'wss://') + v;
}
$('#invite').onclick = async () => {
  if (!invite) return status('Il server non ha un tunnel attivo: gli amici non possono raggiungerlo da internet');
  await navigator.clipboard.writeText(invite);
  status('Codice invito copiato: mandalo ai tuoi amici insieme a Cullary.exe');
};
$('#server').value = localStorage.server || 'ws://localhost:3000';
$('#login').onsubmit = e => {
  e.preventDefault();
  localStorage.server = serverUrl($('#server').value);
  $('#server').value = localStorage.server;
  connect({ t: e.submitter?.value || 'login', user: $('#user').value.trim(), pass: $('#pass').value });
};
$('#logout').onclick = () => { send({ t: 'logout', token: localStorage.token }); delete localStorage.token; location.reload(); };
if (localStorage.token && localStorage.server) connect({ t: 'auth', token: localStorage.token });

function handle(m) {
  switch (m.t) {
    case 'error':
      if (m.auth) { me = null; delete localStorage.token; $('#app').hidden = true; $('#login').hidden = false; $('#login-error').textContent = m.text; }
      else status(m.text);
      break;
    case 'ready':
      me = m.user; localStorage.token = m.token; channels = m.channels; invite = m.invite;
      $('#login').hidden = true; $('#app').hidden = false; $('#me').textContent = me;
      select(channels.includes(current) ? current : channels[0]);
      break;
    case 'channels': channels = m.channels; renderChannels(); break;
    case 'invite': invite = m.invite; break;
    case 'state': voice = m.voice; online = m.online; renderChannels(); syncPeers(); break;
    case 'history':
      if (m.channel !== current) break;
      $('#messages').replaceChildren();
      m.messages.forEach(addMsg);
      break;
    case 'msg':
      if (m.channel === current) addMsg(m);
      else { unread.add(m.channel); renderChannels(); }
      break;
    case 'signal': onSignal(m.from, m.data); break;
  }
}

// ---------- canali e chat ----------
function renderChannels() {
  $('#channels').replaceChildren(...channels.map(c => {
    const inCall = myVoice === c;
    const li = el('li', { className: c === current ? 'active' : unread.has(c) ? 'unread' : '' },
      el('span', { textContent: '# ' + c, onclick: () => select(c) }),
      el('button', { textContent: inCall ? '✕' : '🔊', title: inCall ? 'Esci dalla chiamata' : 'Entra in chiamata', onclick: () => inCall ? leaveVoice() : joinVoice(c) }));
    const members = Object.keys(voice).filter(u => voice[u] === c);
    if (members.length) li.append(el('div', { className: 'members' }, ...members.map(u => el('div', { textContent: '🎙 ' + u }))));
    return li;
  }));
  $('#online').replaceChildren(...online.map(u => el('li', { textContent: '● ' + u })));
}

function select(c) {
  current = c; unread.delete(c);
  $('#chan-title').textContent = '# ' + c;
  $('#messages').replaceChildren();
  send({ t: 'history', channel: c });
  renderChannels();
}

function addMsg(m) {
  const list = $('#messages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(el('li', {}, el('time', { textContent: new Date(m.ts).toLocaleString() }), el('b', { textContent: m.user + ': ' }), m.text));
  if (atBottom) list.scrollTop = list.scrollHeight;
}

$('#chat').onsubmit = e => {
  e.preventDefault();
  const text = $('#text').value.trim();
  if (text) send({ t: 'msg', channel: current, text });
  $('#text').value = '';
};
$('#new-channel').onkeydown = e => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  send({ t: 'create_channel', name: e.target.value.trim() });
  e.target.value = '';
};

// ---------- chiamata (WebRTC mesh, "perfect negotiation") ----------
async function joinVoice(c) {
  leaveVoice();
  try { local.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { status('Nessun microfono: sei in sola ascolto'); }
  myVoice = c;
  document.body.classList.add('in-voice');
  send({ t: 'join_voice', channel: c });
  updateButtons();
}

function leaveVoice(silent) {
  if (!myVoice) return;
  if (!silent) send({ t: 'leave_voice' });
  myVoice = null;
  document.body.classList.remove('in-voice');
  [...peers.keys()].forEach(dropPeer);
  Object.keys(local).forEach(stopShare);
  renderChannels();
}

function syncPeers() {
  if (!myVoice) return;
  const others = Object.keys(voice).filter(u => u !== me && voice[u] === myVoice);
  others.forEach(peer);
  [...peers.keys()].filter(n => !others.includes(n)).forEach(dropPeer);
}

function peer(name) {
  if (peers.has(name)) return peers.get(name);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const p = { pc, polite: me < name, makingOffer: false, ignoreOffer: false, senders: {} };
  peers.set(name, p);
  const signal = data => send({ t: 'signal', to: name, data });
  pc.onicecandidate = e => e.candidate && signal({ candidate: e.candidate });
  pc.onnegotiationneeded = async () => {
    try { p.makingOffer = true; await pc.setLocalDescription(); signal({ description: hqSdp(pc.localDescription) }); }
    catch (e) { console.error(e); }
    finally { p.makingOffer = false; }
  };
  pc.ontrack = ({ track, streams }) => showStream(name, streams[0] || new MediaStream([track]));
  for (const [key, stream] of Object.entries(local)) attach(p, key, stream);
  return p;
}

async function onSignal(from, { description, candidate } = {}) {
  if (!myVoice) return;
  const p = peer(from), pc = p.pc;
  try {
    if (description) {
      const collision = description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        send({ t: 'signal', to: from, data: { description: hqSdp(pc.localDescription) } });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
    }
  } catch (e) { console.error(e); }
}

function dropPeer(name) {
  peers.get(name)?.pc.close();
  peers.delete(name);
  for (const [id, t] of tiles) if (t.owner === name) removeTile(id);
}

// ---------- riquadri video ----------
function showStream(owner, stream, mine) {
  if (tiles.has(stream.id)) return tiles.get(stream.id).update();
  const video = el('video', { srcObject: stream, autoplay: true, playsInline: true, muted: !!mine });
  const tile = el('div', { className: 'tile', title: 'Doppio clic: schermo intero' }, video, el('span', { textContent: owner }));
  tile.owner = owner;
  tile.ondblclick = () => document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen();
  // un riquadro senza video resta nascosto ma riproduce comunque l'audio (voce, audio app)
  tile.update = () => {
    if (!stream.getTracks().length) return removeTile(stream.id);
    tile.hidden = !stream.getVideoTracks().length;
  };
  stream.onaddtrack = stream.onremovetrack = tile.update;
  tiles.set(stream.id, tile);
  $('#stage').append(tile);
  tile.update();
}
function removeTile(id) { tiles.get(id)?.remove(); tiles.delete(id); }

// ---------- condivisioni ----------
const buttons = { cam: '#cam', screen: '#screen', app: '#app-share', audio: '#audio' };
for (const [key, sel] of Object.entries(buttons)) $(sel).onclick = () => share(key);
$('#leave').onclick = () => leaveVoice();
$('#mic').onclick = () => {
  const t = local.mic?.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
  updateButtons();
};

function updateButtons() {
  for (const [key, sel] of Object.entries(buttons)) $(sel).classList.toggle('on', !!local[key]);
  const t = local.mic?.getAudioTracks()[0];
  $('#mic').classList.toggle('off', !t || !t.enabled);
  $('#mic').textContent = t?.enabled ? '🎙 Microfono' : '🔇 Muto';
}

async function share(key) {
  if (local[key]) return stopShare(key);
  if (!myVoice) return;
  let stream;
  try {
    if (key === 'cam') {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const cam = cams.length > 1 ? await pick(cams.map(d => ({ id: d.deviceId, name: d.label || 'Webcam' }))) : cams[0];
      if (!cam || !myVoice) return;
      stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.id ?? cam.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } });
    } else {
      const prefix = key === 'screen' ? 'screen:' : 'window:';
      const src = await pick((await native.sources()).filter(s => s.id.startsWith(prefix)));
      if (!src || !myVoice) return;
      stream = new MediaStream();
      if (key !== 'audio') {
        await native.select(src.id);
        const d = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false });
        // schermo: priorità alla nitidezza (testo); app/giochi: priorità alla fluidità
        d.getVideoTracks().forEach(t => (t.contentHint = key === 'screen' ? 'detail' : 'motion'));
        d.getVideoTracks().forEach(t => stream.addTrack(t));
      }
      try {
        // schermo: tutto l'audio di sistema tranne Cullary (niente eco delle voci); app: solo quel processo
        const a = await appAudio(key === 'screen' ? 'exclude' : 'include', key === 'screen' ? 'self' : src.id);
        a.track.contentHint = 'music'; // Opus in modalità musica, non voce
        stream.addTrack(a.track);
        cleanup[key] = a.stop;
      } catch (e) {
        if (key === 'audio') throw e;
        status('Audio non disponibile: ' + e.message);
      }
    }
  } catch (e) {
    stream?.getTracks().forEach(t => t.stop());
    return status('Impossibile avviare: ' + e.message);
  }
  local[key] = stream;
  stream.getVideoTracks().forEach(t => (t.onended = () => stopShare(key))); // es. finestra chiusa
  for (const p of peers.values()) attach(p, key, stream);
  if (stream.getVideoTracks().length) showStream('Tu', stream, true);
  updateButtons();
}

// Qualità massima per tipo di condivisione: tetto di bitrate/fps per l'encoder (la banda reale la decide WebRTC)
const ENCODING = {
  mic: { audio: { maxBitrate: 128_000 } },
  cam: { video: { maxBitrate: 6_000_000, maxFramerate: 60 } },
  screen: { video: { maxBitrate: 12_000_000, maxFramerate: 60 }, audio: { maxBitrate: 510_000 } },
  app: { video: { maxBitrate: 12_000_000, maxFramerate: 60 }, audio: { maxBitrate: 510_000 } },
  audio: { audio: { maxBitrate: 510_000 } },
};
// VP9 prima: a parità di banda è molto più nitido di VP8 su testo e schermate
const VIDEO_CODECS = RTCRtpReceiver.getCapabilities('video').codecs
  .sort((a, b) => (b.mimeType === 'video/VP9') - (a.mimeType === 'video/VP9'));

function attach(p, key, stream) {
  p.senders[key] = stream.getTracks().map(track => {
    const tr = p.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [ENCODING[key][track.kind] ?? {}] });
    if (track.kind === 'video') tr.setCodecPreferences(VIDEO_CODECS);
    return tr.sender;
  });
}

// Opus stereo a 510 kbps: lo chiediamo a chi ci invia (vale per l'audio di app/schermo; il mic resta mono)
const hqSdp = ({ type, sdp }) => {
  const pt = /a=rtpmap:(\d+) opus\/48000\/2/.exec(sdp)?.[1];
  if (pt) sdp = sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`, 'g'), `a=fmtp:${pt} $1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000`);
  return { type, sdp };
};

function stopShare(key) {
  const s = local[key];
  if (!s) return;
  delete local[key];
  cleanup[key]?.(); delete cleanup[key];
  s.getTracks().forEach(t => t.stop());
  for (const p of peers.values()) {
    (p.senders[key] || []).forEach(x => p.pc.signalingState !== 'closed' && p.pc.removeTrack(x));
    delete p.senders[key];
  }
  removeTile(s.id);
  updateButtons();
}

// items: [{ id, name, thumb? }] -> elemento scelto o null
function pick(items) {
  return new Promise(res => {
    const dlg = $('#picker');
    const done = v => { res(v); dlg.close(); };
    $('#picker-grid').replaceChildren(...items.map(s =>
      el('button', { className: 'src', onclick: () => done(s) }, ...(s.thumb ? [el('img', { src: s.thumb })] : []), el('span', { textContent: s.name }))));
    dlg.onclose = () => res(null);
    dlg.showModal();
  });
}

// ---------- audio nativo per-applicazione (apploopback.exe -> AudioWorklet -> traccia WebRTC) ----------
let ctx;
const sinks = new Map();
native.onPcm((id, data) => sinks.get(id)?.(data));

async function appAudio(mode, target) {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
  }
  const id = await native.audioStart(mode, target);
  const node = new AudioWorkletNode(ctx, 'pcm', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);
  let rest = new Uint8Array(0);
  sinks.set(id, data => {
    const buf = rest.length ? new Uint8Array([...rest, ...data]) : data;
    const bytes = buf.length & ~3; // frame interi: 2 canali x 16 bit
    const s16 = new Int16Array(buf.slice(0, bytes).buffer);
    rest = buf.slice(bytes);
    const f = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) f[i] = s16[i] / 32768;
    node.port.postMessage(f, [f.buffer]);
  });
  return {
    track: dest.stream.getAudioTracks()[0],
    stop: () => { native.audioStop(id); sinks.delete(id); node.disconnect(); },
  };
}
