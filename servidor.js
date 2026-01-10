const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// Detecta automaticamente se tem Persistent Disk
const AUTH_FOLDER = process.env.AUTH_PATH || (
  fs.existsSync('/var/data') ? '/var/data/auth_info' : './auth_info'
);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));

const logger = pino({ level: 'warn' });

let sock = null;
let qrCode = null;
let isConnected = false;
let isConnecting = false;
let connectionError = null;
let messages = [];
const MAX_MESSAGES = 200;

const formatPhone = (phone) => {
  if (!phone) return null;
  if (phone.includes('@')) return phone;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
};

const addMessage = (msg) => {
  messages.unshift(msg);
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(0, MAX_MESSAGES);
  }
};

const log = (level, action, detail = '') => {
  const ts = new Date().toISOString();
  const emoji = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
  console.log(`[${ts}] ${emoji} ${action}: ${detail}`);
};

async function connectWhatsApp() {
  if (isConnecting) {
    log('warn', 'connect', 'Já está conectando, aguarde...');
    return;
  }

  isConnecting = true;
  connectionError = null;

  try {
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      log('info', 'auth', `Pasta criada: ${AUTH_FOLDER}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    log('info', 'connect', `Iniciando Baileys v${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: true,
      logger,
      browser: ['WhatsApp Server', 'Chrome', '22.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        isConnected = false;
        log('info', 'qr', 'QR Code gerado. Escaneie!');
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        qrCode = null;

        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

        if (reason === DisconnectReason.loggedOut) {
          log('info', 'logout', 'Logout detectado. Limpando...');
          try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch {}
          connectionError = 'Deslogado. Escaneie o QR novamente.';
        } else if (reason === DisconnectReason.restartRequired) {
          setTimeout(connectWhatsApp, 1000);
        } else {
          setTimeout(connectWhatsApp, 3000);
        }
      }

      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        qrCode = null;
        connectionError = null;
        log('success', 'connect', 'WhatsApp conectado!');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
      if (type !== 'notify') return;

      for (const msg of newMessages) {
        if (!msg.message) continue;
        const from = msg.key.remoteJid;
        if (from === 'status@broadcast' || from?.endsWith('@g.us')) continue;

        const text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption || '';

        addMessage({
          id: msg.key.id,
          from,
          fromMe: msg.key.fromMe,
          text,
          name: msg.pushName || '',
          timestamp: Date.now(),
          type: Object.keys(msg.message)[0],
        });
      }
    });

  } catch (error) {
    isConnecting = false;
    connectionError = error.message;
    log('error', 'connect', error.message);
    setTimeout(connectWhatsApp, 10000);
  }
}

// ========== ROTAS ==========

app.get('/', (req, res) => {
  res.json({
    ok: true,
    server: 'whatsapp-server',
    connected: isConnected,
    hasQR: !!qrCode,
    authPath: AUTH_FOLDER,
  });
});

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    connected: isConnected,
    connecting: isConnecting,
    error: connectionError,
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) return res.json({ qr: null, connected: true });
  res.json({ qr: qrCode || null });
});

app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ messages: messages.slice(0, limit) });
});

app.post('/send', async (req, res) => {
  try {
    const { to, text, message } = req.body;
    const content = text || message;
    if (!to || !content) return res.status(400).json({ ok: false, error: 'Faltando to/text' });
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });

    const jid = formatPhone(to);
    const result = await sock.sendMessage(jid, { text: content });
    res.json({ ok: true, id: result?.key?.id });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-audio', async (req, res) => {
  try {
    const { to, audio, mimetype, ptt } = req.body;
    if (!to || !audio) return res.status(400).json({ ok: false, error: 'Faltando to/audio' });
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });

    const jid = formatPhone(to);
    let audioBuffer = Buffer.from(audio, 'base64');
    const inputMimetype = (mimetype || '').toLowerCase();
    let finalMimetype = 'audio/ogg; codecs=opus';

    log('info', 'audio', `Recebido ${Math.round(audioBuffer.length/1024)}KB (${inputMimetype})`);

    // Converte WebM para OGG com FFmpeg
    if (inputMimetype.includes('webm')) {
      try {
        const { execSync } = require('child_process');
        const os = require('os');
        const tmpDir = os.tmpdir();
        const ts = Date.now();
        const inputPath = path.join(tmpDir, `in_${ts}.webm`);
        const outputPath = path.join(tmpDir, `out_${ts}.ogg`);

        fs.writeFileSync(inputPath, audioBuffer);
        execSync(`ffmpeg -i "${inputPath}" -c:a libopus -b:a 64k "${outputPath}" -y`, {
          timeout: 30000, stdio: 'pipe'
        });

        audioBuffer = fs.readFileSync(outputPath);
        finalMimetype = 'audio/ogg; codecs=opus';
        log('success', 'audio', 'Convertido para OGG!');

        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
      } catch (e) {
        log('error', 'audio', `FFmpeg falhou: ${e.message}`);
        return res.status(500).json({ ok: false, error: 'Conversão de áudio falhou. FFmpeg não disponível.' });
      }
    }

    const result = await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: finalMimetype,
      ptt: ptt !== false,
    });

    log('success', 'audio', `Enviado! ID: ${result?.key?.id}`);
    res.json({ ok: true, id: result?.key?.id });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;
    if (!to || !image) return res.status(400).json({ ok: false, error: 'Faltando to/image' });
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });

    const jid = formatPhone(to);
    const result = await sock.sendMessage(jid, {
      image: Buffer.from(image, 'base64'),
      caption: caption || '',
    });
    res.json({ ok: true, id: result?.key?.id });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-video', async (req, res) => {
  try {
    const { to, video, caption } = req.body;
    if (!to || !video) return res.status(400).json({ ok: false, error: 'Faltando to/video' });
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });

    const jid = formatPhone(to);
    const result = await sock.sendMessage(jid, {
      video: Buffer.from(video, 'base64'),
      caption: caption || '',
    });
    res.json({ ok: true, id: result?.key?.id });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-document', async (req, res) => {
  try {
    const { to, document, filename, mimetype } = req.body;
    if (!to || !document) return res.status(400).json({ ok: false, error: 'Faltando to/document' });
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });

    const jid = formatPhone(to);
    const result = await sock.sendMessage(jid, {
      document: Buffer.from(document, 'base64'),
      fileName: filename || 'arquivo',
      mimetype: mimetype || 'application/octet-stream',
    });
    res.json({ ok: true, id: result?.key?.id });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
    isConnected = false;
    qrCode = null;
    try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch {}
    res.json({ ok: true, message: 'Desconectado' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/reconnect', async (req, res) => {
  if (sock) sock.end();
  isConnected = false;
  isConnecting = false;
  qrCode = null;
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, message: 'Reconectando...' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📁 Auth: ${AUTH_FOLDER}\n`);
  connectWhatsApp();
});

process.on('SIGTERM', () => { if (sock) sock.end(); process.exit(0); });
process.on('SIGINT', () => { if (sock) sock.end(); process.exit(0); });
