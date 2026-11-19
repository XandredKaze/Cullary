const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const HELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'apploopback.exe')
  : path.join(__dirname, '..', 'native', 'apploopback.exe');
const helpers = new Map();
let nextId = 1, chosen = null;

app.whenReady().then(() => {
  // getDisplayMedia nel renderer usa la sorgente scelta nel nostro picker
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const src = (await desktopCapturer.getSources({ types: ['screen', 'window'] })).find(s => s.id === chosen);
    cb(src ? { video: src } : {});
  });
  const win = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#313338', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => helpers.forEach(p => p.kill()));

ipcMain.handle('sources', async () =>
  (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }))
    .map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));

ipcMain.handle('select', (_e, id) => { chosen = String(id); });

// mode: 'include' (solo quell'app) | 'exclude' (tutto tranne Cullary); target: 'self' | 'window:HWND:0'
ipcMain.handle('audio-start', (e, mode, target) => {
  if (!['include', 'exclude'].includes(mode)) throw new Error('modalità non valida');
  const hwnd = /^window:(\d+):/.exec(target)?.[1];
  const arg = target === 'self' ? String(process.pid) : hwnd ? 'hwnd:' + hwnd : null;
  if (!arg) throw new Error('sorgente non valida');
  if (!existsSync(HELPER)) throw new Error('apploopback.exe mancante: esegui native\\build.bat');
  const id = nextId++;
  const p = spawn(HELPER, [mode, arg]);
  helpers.set(id, p);
  p.stdout.on('data', d => !e.sender.isDestroyed() && e.sender.send('pcm', id, d));
  p.stderr.on('data', d => console.error('apploopback:', String(d).trim()));
  p.on('exit', () => helpers.delete(id));
  return id;
});
ipcMain.handle('audio-stop', (_e, id) => helpers.get(id)?.kill());
