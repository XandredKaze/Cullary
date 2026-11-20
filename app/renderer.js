const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // sostituito dai server TURN che manda il server

// indirizzo fisso del server su Cloudflare (devServer: solo per i test in locale)
const SERVER = localStorage.devServer || 'wss://cullary.cullary-server.workers.dev';
let ws, me = null, current = null, myVoice = null, channels = [], voice = {}, online = [], profiles = {}, msgs = [];
const peers = new Map();   // nome -> { name, pc, polite, makingOffer, ignoreOffer, senders }
const tiles = new Map();   // stream.id -> riquadro
const kinds = new Map();   // stream.id remoto -> mic | cam | screen | app | audio (lo dice chi invia)
const local = {};          // mic | cam | screen | app | audio -> MediaStream
const cleanup = {};        // chiave -> stop dell'audio nativo
const unread = new Set();
let deafened = false, chatUnseen = 0;

// ---------- preferenze salvate su questo PC ----------
const prefs = Object.assign(
  { mic: null, out: null, cam: null, ns: true, ec: true, agc: true, micGain: 100, theme: 'dark', accent: '#5865f2', fontSize: 15, chatOpen: true, volumes: {} },
  (() => { try { return JSON.parse(localStorage.prefs || '{}'); } catch { return {}; } })());
const savePrefs = () => (localStorage.prefs = JSON.stringify(prefs));

// ---------- connessione e login ----------
function connect(first) {
  ws?.close();
  const sock = ws = new WebSocket(SERVER);
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
  for (const n of [$('#status'), $('#settings-msg')]) n.textContent = text;
  clearTimeout(status.t);
  status.t = setTimeout(() => { $('#status').textContent = ''; $('#settings-msg').textContent = ''; }, 6000);
}

$('#login').onsubmit = e => {
  e.preventDefault();
  connect({ t: e.submitter?.value || 'login', user: $('#user').value.trim(), pass: $('#pass').value });
};
$('#logout').onclick = () => { send({ t: 'logout', token: localStorage.token }); delete localStorage.token; location.reload(); };
if (localStorage.token) connect({ t: 'auth', token: localStorage.token });

function handle(m) {
  switch (m.t) {
    case 'error':
      if (m.auth) { me = null; delete localStorage.token; $('#app').hidden = true; $('#login').hidden = false; $('#login-error').textContent = m.text; }
      else status(m.text);
      break;
    case 'ready':
      me = m.user; localStorage.token = m.token; channels = m.channels; profiles = m.profiles || {}; if (m.ice) ICE = m.ice;
      $('#login').hidden = true; $('#app').hidden = false;
      renderMe();
      select(channels.includes(current) ? current : channels[0]);
      break;
    case 'channels': channels = m.channels; renderChannels(); break;
    case 'state': voice = m.voice; online = m.online; renderChannels(); syncPeers(); break;
    case 'profile': profiles[m.user] = m.profile; refreshNames(); break;
    case 'history':
      if (m.channel !== current) break;
      msgs = m.messages;
      renderMessages();
      break;
    case 'msg':
      if (m.channel !== current) { unread.add(m.channel); renderChannels(); break; }
      addMsg(m);
      if (myVoice && !prefs.chatOpen) { chatUnseen++; $('#toggle-chat').dataset.badge = chatUnseen; }
      break;
    case 'signal': onSignal(m.from, m.data); break;
  }
}

// ---------- profili e avatar ----------
const profile = u => profiles[u] || {};
const displayName = u => profile(u).nick || u || '?';
const hue = u => `hsl(${[...String(u)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360} 45% 45%)`;
function avatar(u, size = '') {
  const p = profile(u), [color, style] = (p.border || '|none').split('|');
  const a = el('span', { className: `avatar ${size}`, title: displayName(u) });
  a.dataset.style = style || 'none';
  a.style.setProperty('--ring', color || 'transparent');
  if (p.avatar) a.append(el('img', { src: p.avatar, alt: '' }));
  else { a.textContent = displayName(u).slice(0, 1).toUpperCase(); a.style.background = hue(u); }
  return a;
}
const person = (u, size = 'small') => el('div', { className: 'person' }, avatar(u, size), el('span', { textContent: displayName(u) }));

function renderMe() {
  $('#me-avatar').replaceChildren(avatar(me));
  $('#me-nick').textContent = displayName(me);
  $('#me-name').textContent = '@' + me;
}
function refreshNames() {
  renderMe(); renderChannels(); renderMessages();
  tiles.forEach(t => t.refresh());
}

// ---------- canali e chat ----------
function renderChannels() {
  $('#channels').replaceChildren(...channels.map(c => {
    const inCall = myVoice === c;
    const li = el('li', { className: c === current ? 'active' : unread.has(c) ? 'unread' : '' },
      el('span', { textContent: '# ' + c, onclick: () => select(c) }),
      el('button', { textContent: inCall ? '✕' : '🔊', title: inCall ? 'Esci dalla chiamata' : 'Entra in chiamata', ariaLabel: (inCall ? 'Esci dalla chiamata ' : 'Entra in chiamata ') + c, onclick: () => inCall ? leaveVoice() : joinVoice(c) }));
    const members = Object.keys(voice).filter(u => voice[u] === c);
    if (members.length) li.append(el('div', { className: 'members' }, ...members.map(u => person(u))));
    return li;
  }));
  $('#online').replaceChildren(...online.map(u => el('li', {}, person(u))));
}

function select(c) {
  current = c; unread.delete(c); msgs = [];
  $('#chan-title').textContent = '# ' + c;
  renderMessages();
  send({ t: 'history', channel: c });
  renderChannels();
}

const msgEl = m => el('li', { className: 'msg' }, avatar(m.user),
  el('div', {}, el('div', { className: 'msg-head' }, el('b', { textContent: displayName(m.user) }), el('time', { textContent: new Date(m.ts).toLocaleString() })),
    el('div', { className: 'msg-text', textContent: m.text })));
function renderMessages() {
  const list = $('#messages');
  list.replaceChildren(...msgs.map(msgEl));
  list.scrollTop = list.scrollHeight;
}
function addMsg(m) {
  msgs.push(m);
  const list = $('#messages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(msgEl(m));
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

function setChat(open) {
  prefs.chatOpen = open; savePrefs();
  document.body.classList.toggle('chat-hidden', !open);
  $('#toggle-chat').setAttribute('aria-pressed', open);
  if (open) { chatUnseen = 0; $('#toggle-chat').dataset.badge = ''; $('#messages').scrollTop = $('#messages').scrollHeight; }
  layout();
}
$('#toggle-chat').onclick = () => setChat(!prefs.chatOpen);

// ---------- dispositivi audio/video ----------
let ctxP;
const audioCtx = () => (ctxP ??= (async () => {
  const c = new AudioContext({ sampleRate: 48000 });
  await c.audioWorklet.addModule('pcm-worklet.js');
  return c;
})());

const findDevice = (list, saved) => saved && (list.find(d => d.deviceId === saved.id) || list.find(d => d.label && d.label === saved.label));

// Il microfono passa da un GainNode verso una traccia fissa: cambiare dispositivo o volume non tocca le chiamate
const mic = { raw: null, src: null, gain: null, an: null, dest: null };
async function micChain() {
  const ac = await audioCtx();
  if (ac.state === 'suspended') await ac.resume();
  if (!mic.gain) {
    mic.gain = ac.createGain();
    mic.an = ac.createAnalyser(); mic.an.fftSize = 512;
    mic.dest = ac.createMediaStreamDestination();
    mic.gain.connect(mic.dest); mic.gain.connect(mic.an);
  }
  mic.gain.gain.value = prefs.micGain / 100;
  if (!mic.raw) await reopenMic();
  return mic.dest.stream;
}
async function reopenMic() {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  const d = findDevice(list, prefs.mic);
  if (prefs.mic && !d && list.length) status('Microfono salvato non trovato: uso quello predefinito');
  const raw = await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: d ? { exact: d.deviceId } : undefined, echoCancellation: prefs.ec, noiseSuppression: prefs.ns, autoGainControl: prefs.agc } });
  closeMic();
  mic.raw = raw;
  mic.src = (await audioCtx()).createMediaStreamSource(raw);
  mic.src.connect(mic.gain);
  raw.getAudioTracks()[0].onended = () => reopenMic().then(() => status('Microfono scollegato: uso quello predefinito')).catch(() => status('Nessun microfono disponibile'));
}
function closeMic() {
  mic.raw?.getTracks().forEach(t => t.stop());
  mic.src?.disconnect();
  mic.raw = mic.src = null;
}
function applyOutput() {
  for (const t of tiles.values()) if (!t.mine) t.video.setSinkId?.(prefs.out?.id || '').catch(() => {});
}
navigator.mediaDevices.ondevicechange = () => { if ($('#settings').open) fillDevices(); };

// ---------- chiamata (WebRTC mesh, "perfect negotiation") ----------
async function joinVoice(c) {
  leaveVoice();
  try { await micChain(); } catch { status('Nessun microfono: gli altri non ti sentiranno'); }
  local.mic = mic.dest.stream;
  myVoice = c;
  document.body.classList.add('in-voice');
  setChat(prefs.chatOpen);
  showStream(me, local.mic, 'mic');
  send({ t: 'join_voice', channel: c });
  updateButtons();
}

function leaveVoice(silent) {
  if (!myVoice) return;
  if (!silent) send({ t: 'leave_voice' });
  myVoice = null;
  if (document.fullscreenElement) document.exitFullscreen();
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
  const p = { name, pc, polite: me < name, makingOffer: false, ignoreOffer: false, senders: {} };
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

async function onSignal(from, data = {}) {
  if (data.meta) { // che cosa è ogni stream (microfono, webcam, schermo…): serve per etichette e volumi
    for (const [id, kind] of Object.entries(data.meta)) { kinds.set(id, kind); tiles.get(id)?.refresh(); }
    return;
  }
  if (!myVoice) return;
  // in ordine, uno alla volta per persona: se una risposta e una nuova offerta arrivano attaccate,
  // l'offerta va valutata solo dopo che la risposta è applicata, altrimenti sembra una collisione e si perde
  const p = peer(from);
  p.queue = (p.queue || Promise.resolve()).then(() => applySignal(p, from, data));
}

async function applySignal(p, from, { description, candidate }) {
  const pc = p.pc;
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

// ---------- riquadri della chiamata ----------
const KIND_LABEL = { screen: 'Schermo', app: 'App', audio: 'Audio app' };
const toggleFullscreen = node => (document.fullscreenElement === node ? document.exitFullscreen() : node.requestFullscreen());

// localKey: chiave della condivisione se lo stream è nostro (anteprima muta), altrimenti undefined
function showStream(owner, stream, localKey) {
  if (tiles.has(stream.id)) return tiles.get(stream.id).refresh();
  const mine = !!localKey;
  const video = el('video', { srcObject: stream, autoplay: true, playsInline: true, muted: mine });
  const card = el('div', { className: 'card' });
  const label = el('span', { className: 'label' });
  const fs = el('button', { className: 'fs', textContent: '⛶', title: 'Schermo intero (doppio clic)', ariaLabel: 'Schermo intero', onclick: e => { e.stopPropagation(); toggleFullscreen(tile); } });
  const bar = el('div', { className: 'bar' }, label);
  const tile = el('div', { className: 'tile', tabIndex: 0 }, video, card, bar);
  Object.assign(tile, { owner, mine, video });
  tile.ondblclick = () => !tile.classList.contains('no-video') && toggleFullscreen(tile);
  // finché non arriva la "meta" di chi invia, uno stream con video lo trattiamo come webcam
  const kind = tile.kind = () => localKey || kinds.get(stream.id) || (stream.getVideoTracks().length ? 'cam' : 'mic');

  let vol;
  if (!mine) {
    // volume per persona e tipo (es. "luca:mic", "luca:app"), ricordato tra una chiamata e l'altra.
    // Il riquadro della webcam regola il microfono della stessa persona (il suo avatar è nascosto).
    const key = () => `${owner}:${kind() === 'cam' ? 'mic' : kind()}`;
    const state = () => (prefs.volumes[key()] ??= { v: 100, m: false });
    const range = el('input', { type: 'range', min: 0, max: 100, step: 5, title: 'Volume' });
    const muteBtn = el('button', { title: 'Silenzia solo questo' });
    vol = el('div', { className: 'vol' }, muteBtn, range);
    tile.applyVolume = () => {
      const s = state();
      range.value = s.v;
      if (kind() !== 'cam') { video.volume = s.v / 100; video.muted = s.m || deafened; }
      muteBtn.textContent = s.m || !s.v ? '🔇' : '🔊';
      range.ariaLabel = `Volume di ${label.textContent}`; range.ariaValueText = s.v + '%';
    };
    range.oninput = () => { state().v = +range.value; state().m = false; savePrefs(); applyVolumes(); };
    range.onclick = muteBtn.ondblclick = e => e.stopPropagation();
    muteBtn.onclick = e => { e.stopPropagation(); state().m = !state().m; savePrefs(); applyVolumes(); };
    if (prefs.out?.id) video.setSinkId?.(prefs.out.id).catch(() => {});
    bar.append(vol);
  }
  bar.append(fs);

  tile.refresh = () => {
    if (!stream.getTracks().length) return removeTile(stream.id);
    const k = kind(), name = owner === me ? 'Tu' : displayName(owner);
    label.textContent = KIND_LABEL[k] ? `${name} · ${KIND_LABEL[k]}` : name;
    tile.classList.toggle('no-video', !stream.getVideoTracks().length);
    card.replaceChildren(k === 'audio' ? el('span', { className: 'avatar big icon', textContent: '🔈' }) : avatar(owner, 'big'));
    if (vol) vol.hidden = k === 'cam' ? !micTile(owner) : !stream.getAudioTracks().length;
    tile.applyVolume?.();
    layout();
  };
  stream.onaddtrack = stream.onremovetrack = tile.refresh;
  tiles.set(stream.id, tile);
  $('#stage').append(tile);
  tile.refresh();
}
function removeTile(id) { tiles.get(id)?.remove(); tiles.delete(id); layout(); }
const micTile = owner => [...tiles.values()].find(t => t.owner === owner && t.kind() === 'mic');
const applyVolumes = () => tiles.forEach(t => t.applyVolume?.());

// sceglie il numero di colonne che rende i riquadri 16:9 più grandi possibile nello spazio disponibile
function layout() {
  // chi ha la webcam accesa non ha bisogno anche del riquadro con l'avatar (resta nascosto ma l'audio continua)
  const withCam = new Set([...tiles.values()].filter(t => t.kind() === 'cam' && !t.classList.contains('no-video')).map(t => t.owner));
  for (const t of tiles.values()) if (t.kind() === 'mic') t.hidden = withCam.has(t.owner);
  for (const t of tiles.values()) if (t.kind() === 'cam' && !t.mine) t.querySelector('.vol').hidden = !micTile(t.owner);
  const stage = $('#stage'), n = [...stage.children].filter(t => !t.hidden).length;
  if (!n || !stage.clientWidth) return;
  const gap = 8, W = stage.clientWidth - 16, H = stage.clientHeight - 16;
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    best = Math.max(best, Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9));
  }
  stage.style.setProperty('--tile-w', Math.floor(best) + 'px');
}
new ResizeObserver(layout).observe($('#stage'));

// ---------- controlli ----------
const buttons = { cam: '#cam', screen: '#screen', app: '#app-share', audio: '#audio' };
for (const [key, sel] of Object.entries(buttons)) $(sel).onclick = () => share(key);
$('#leave').onclick = () => leaveVoice();
$('#mic').onclick = toggleMic;
$('#deafen').onclick = toggleDeafen;
$('#call-fullscreen').onclick = () => toggleFullscreen($('#call'));

function toggleMic() {
  const t = local.mic?.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
  updateButtons();
}
function toggleDeafen() {
  deafened = !deafened;
  tiles.forEach(t => t.applyVolume?.());
  updateButtons();
}
function updateButtons() {
  for (const [key, sel] of Object.entries(buttons)) $(sel).classList.toggle('on', !!local[key]);
  const t = local.mic?.getAudioTracks()[0], micOn = !!mic.raw && t?.enabled;
  $('#mic').classList.toggle('off', !micOn);
  $('#mic').firstChild.textContent = micOn ? '🎙 ' : '🔇 ';
  $('#mic').setAttribute('aria-pressed', !micOn);
  $('#deafen').classList.toggle('off', deafened);
  $('#deafen').setAttribute('aria-pressed', deafened);
}

document.addEventListener('keydown', e => {
  if (!me || !e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (e.key === ',') openSettings();
  else if (e.shiftKey && k === 'm' && myVoice) toggleMic();
  else if (e.shiftKey && k === 'd' && myVoice) toggleDeafen();
  else if (e.shiftKey && k === 'c' && myVoice) setChat(!prefs.chatOpen);
  else return;
  e.preventDefault();
});

async function openCamera() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  let cam = findDevice(cams, prefs.cam);
  if (!cam && cams.length > 1) { // prima volta: si sceglie e si ricorda
    const choice = await pick(cams.map(d => ({ id: d.deviceId, name: d.label || 'Webcam' })));
    if (!choice) return null;
    cam = cams.find(d => d.deviceId === choice.id);
    prefs.cam = { id: cam.deviceId, label: cam.label }; savePrefs();
  }
  return navigator.mediaDevices.getUserMedia({ video: {
    deviceId: cam ? { exact: cam.deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } });
}

async function share(key) {
  if (local[key]) return stopShare(key);
  if (!myVoice) return;
  let stream;
  try {
    if (key === 'cam') {
      stream = await openCamera();
      if (!stream || !myVoice) return stream?.getTracks().forEach(t => t.stop());
    } else {
      const prefix = key === 'screen' ? 'screen:' : 'window:';
      const src = await pick((await native.sources()).filter(s => s.id.startsWith(prefix)));
      if (!src || !myVoice) return;
      stream = new MediaStream();
      if (key !== 'audio') {
        await native.select(src.id);
        const d = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false });
        // schermo: priorità alla nitidezza (testo); app/giochi: priorità alla fluidità
        d.getVideoTracks().forEach(t => { t.contentHint = key === 'screen' ? 'detail' : 'motion'; stream.addTrack(t); });
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
  showStream(me, stream, key);
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
  send({ t: 'signal', to: p.name, data: { meta: { [stream.id]: key } } });
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
  if (key === 'mic') closeMic(); // la traccia del mic resta viva e si riusa alla prossima chiamata
  else s.getTracks().forEach(t => t.stop());
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
      el('button', { className: 'src', onclick: () => done(s) }, ...(s.thumb ? [el('img', { src: s.thumb, alt: '' })] : []), el('span', { textContent: s.name }))));
    dlg.onclose = () => res(null);
    dlg.showModal();
  });
}

// ---------- audio nativo per-applicazione (apploopback.exe -> AudioWorklet -> traccia WebRTC) ----------
const sinks = new Map();
native.onPcm((id, data) => sinks.get(id)?.(data));

async function appAudio(mode, target) {
  const ac = await audioCtx();
  const id = await native.audioStart(mode, target);
  const node = new AudioWorkletNode(ac, 'pcm', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ac.createMediaStreamDestination();
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

// ---------- impostazioni ----------
$('#open-settings').onclick = () => openSettings();
$$('[data-tab]').forEach(b => (b.onclick = () => selectTab(b.dataset.tab)));
$('#settings').onclose = stopPreviews;

function openSettings(tab = 'profile') {
  fillProfile();
  $('#settings').showModal();
  selectTab(tab);
}
function selectTab(tab) {
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  $$('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== tab));
  stopPreviews();
  if (tab === 'devices') openDevices();
}

// profilo
let pfAvatar = null;
function fillProfile() {
  const p = profile(me), [color, style] = (p.border || '#5865f2|none').split('|');
  $('#pf-nick').value = p.nick || '';
  $('#pf-border').value = color;
  $('#pf-border-style').value = style;
  $('#pf-preview-name').textContent = '@' + me;
  pfAvatar = p.avatar || null;
  previewProfile();
}
function previewProfile() {
  const draft = { nick: $('#pf-nick').value.trim() || null, avatar: pfAvatar, border: `${$('#pf-border').value}|${$('#pf-border-style').value}` };
  const saved = profiles[me];
  profiles[me] = draft;
  $('#pf-preview').replaceChildren(avatar(me, 'big'));
  $('#pf-preview-nick').textContent = displayName(me);
  profiles[me] = saved;
  return draft;
}
for (const id of ['#pf-nick', '#pf-border', '#pf-border-style']) $(id).oninput = previewProfile;
$('#pf-avatar').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { pfAvatar = await shrinkImage(f); previewProfile(); } catch { status('Immagine non valida'); }
};
$('#pf-avatar-remove').onclick = () => { pfAvatar = null; previewProfile(); };
$('#pf-save').onclick = () => { send({ t: 'profile', ...previewProfile() }); status('Profilo salvato ✓'); };
async function shrinkImage(file) { // ritaglio quadrato al centro, 128 px, WebP: ~10 KB
  const img = await createImageBitmap(file), s = Math.min(img.width, img.height);
  const c = el('canvas', { width: 128, height: 128 });
  c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
  return c.toDataURL('image/webp', 0.85);
}

// dispositivi
let meterRaf = 0, camPreview = null;
async function openDevices() {
  $('#opt-ns').checked = prefs.ns; $('#opt-ec').checked = prefs.ec; $('#opt-agc').checked = prefs.agc;
  $('#mic-gain').value = prefs.micGain; $('#mic-gain-out').value = prefs.micGain + '%';
  try { await micChain(); } catch { status('Nessun microfono disponibile'); }
  await fillDevices();
  const buf = new Uint8Array(mic.an?.fftSize || 512);
  const tick = () => {
    if (!mic.an) return;
    mic.an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $('#mic-meter').style.width = Math.min(100, peak / 128 * 160) + '%';
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}
function stopPreviews() {
  cancelAnimationFrame(meterRaf);
  $('#mic-meter').style.width = '0';
  stopCamPreview();
  if (!myVoice) closeMic();
}

async function fillDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, saved, defaultName) => {
    const list = all.filter(d => d.kind === kind && d.deviceId !== 'communications');
    const cur = findDevice(list, saved) || list.find(d => d.deviceId === 'default') || list[0];
    sel.replaceChildren(...list.map(d => {
      const name = d.deviceId === 'default' ? `${defaultName} (${d.label.replace(/^(Default|Predefinito) - /, '')})` : d.label || 'Dispositivo';
      const o = el('option', { value: d.deviceId, textContent: name, selected: d === cur });
      o.dataset.label = d.label;
      return o;
    }));
    if (!list.length) sel.append(el('option', { textContent: 'Nessun dispositivo trovato', disabled: true, selected: true }));
  };
  fill($('#dev-mic'), 'audioinput', prefs.mic, 'Predefinito di Windows');
  fill($('#dev-out'), 'audiooutput', prefs.out, 'Predefinito di Windows');
  fill($('#dev-cam'), 'videoinput', prefs.cam, 'Predefinita');
}
const chosen = sel => { const o = sel.selectedOptions[0]; return o && !o.disabled ? { id: o.value, label: o.dataset.label } : null; };

$('#dev-mic').onchange = async () => {
  prefs.mic = chosen($('#dev-mic')); savePrefs();
  if (mic.raw) await reopenMic().catch(e => status('Microfono non disponibile: ' + e.message));
  status('Microfono salvato ✓');
};
$('#dev-out').onchange = () => { prefs.out = chosen($('#dev-out')); savePrefs(); applyOutput(); status('Uscita audio salvata ✓'); };
$('#dev-cam').onchange = async () => {
  prefs.cam = chosen($('#dev-cam')); savePrefs();
  if (camPreview) await startCamPreview();
  if (local.cam) { stopShare('cam'); await share('cam'); }
  status('Webcam salvata ✓');
};
for (const k of ['ns', 'ec', 'agc']) $('#opt-' + k).onchange = async e => {
  prefs[k] = e.target.checked; savePrefs();
  if (mic.raw) await reopenMic().catch(err => status('Microfono non disponibile: ' + err.message));
};
$('#mic-gain').oninput = e => {
  prefs.micGain = +e.target.value; savePrefs();
  if (mic.gain) mic.gain.gain.value = prefs.micGain / 100;
  $('#mic-gain-out').value = prefs.micGain + '%';
};
$('#test-out').onclick = () => {
  const id = prefs.out?.id;
  const ac = new AudioContext(id && id !== 'default' ? { sinkId: id } : {});
  const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
  o.frequency.setValueAtTime(880, t); o.frequency.setValueAtTime(660, t + 0.15);
  g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  o.connect(g).connect(ac.destination); o.start(); o.stop(t + 0.6);
  setTimeout(() => ac.close(), 800);
};
$('#cam-test').onclick = () => (camPreview ? stopCamPreview() : startCamPreview());
async function startCamPreview() {
  stopCamPreview();
  try {
    camPreview = await openCamera();
    if (!camPreview) return;
    $('#cam-preview').srcObject = camPreview; $('#cam-preview').hidden = false;
    $('#cam-test').textContent = '⏹ Ferma anteprima';
    fillDevices(); // ora i nomi delle webcam sono visibili
  } catch (e) { status('Webcam non disponibile: ' + e.message); }
}
function stopCamPreview() {
  camPreview?.getTracks().forEach(t => t.stop());
  camPreview = null;
  $('#cam-preview').srcObject = null; $('#cam-preview').hidden = true;
  $('#cam-test').textContent = '📷 Prova webcam';
}

// aspetto
function applyLook() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.style.setProperty('--accent', prefs.accent);
  root.style.fontSize = prefs.fontSize + 'px';
}
$('#theme').value = prefs.theme;
$('#accent').value = prefs.accent;
$('#font-size').value = prefs.fontSize; $('#font-size-out').value = prefs.fontSize + ' px';
$('#theme').onchange = e => { prefs.theme = e.target.value; savePrefs(); applyLook(); };
$('#accent').oninput = e => { prefs.accent = e.target.value; savePrefs(); applyLook(); };
$('#font-size').oninput = e => { prefs.fontSize = +e.target.value; $('#font-size-out').value = prefs.fontSize + ' px'; savePrefs(); applyLook(); };
applyLook();
setChat(prefs.chatOpen);
