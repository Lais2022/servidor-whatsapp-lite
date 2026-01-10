// ============================================================
// WHATSAPP SERVER LITE - VERSÃO COMPLETA
// ============================================================

import express from 'express';
import cors from 'cors';
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const logger = pino({ level: 'warn' });

let sock = null;
let qrCode = null;
let isConnected = false;
let messages = [];
const MAX_MESSAGES = 100;
const AUTH_FOLDER = './auth_info';

const formatPhone = (phone) => {
  if (!phone) return null;
  if (phone.includes('@')) return phone;
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
};

const addMessage = (msg) => {
  messages.unshift(msg);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(0, MAX_MESSAGES);
};

async function connectWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: true,
      logger,
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory: false,
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrCode = qr; isConnected = false; }
      if (connection === 'close') {
        isConnected = false; qrCode = null;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason !== DisconnectReason.loggedOut) setTimeout(connectWhatsApp, 3000);
        else fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      }
      if (connection === 'open') { isConnected = true; qrCode = null; console.log('WhatsApp conectado!'); }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
      if (type !== 'notify') return;
      for (const msg of newMessages) {
        if (!msg.message) continue;
        addMessage({
          id: msg.key.id,
          from: msg.key.remoteJid,
          fromMe: msg.key.fromMe,
          text: msg.message.conversation || msg.message.extendedTextMessage?.text || '',
          timestamp: msg.messageTimestamp * 1000,
        });
      }
    });
  } catch (error) {
    console.error('Erro ao conectar:', error);
    setTimeout(connectWhatsApp, 5000);
  }
}

// ROTAS
app.get('/', (req, res) => res.json({ ok: true, connected: isConnected }));
app.get('/status', (req, res) => res.json({ ok: true, connected: isConnected }));
app.get('/qr', (req, res) => res.json({ qr: isConnected ? null : qrCode }));
app.get('/messages', (req, res) => res.json({ messages }));

// ENVIAR TEXTO
app.post('/send', async (req, res) => {
  try {
    const { to, text, message } = req.body;
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });
    const result = await sock.sendMessage(formatPhone(to), { text: text || message });
    res.json({ ok: true, success: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ENVIAR ÁUDIO (PTT)
app.post('/send-audio', async (req, res) => {
  try {
    const { to, audio, mimetype, ptt } = req.body;
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });
    const result = await sock.sendMessage(formatPhone(to), {
      audio: Buffer.from(audio, 'base64'),
      mimetype: mimetype || 'audio/ogg; codecs=opus',
      ptt: ptt !== false,
    });
    res.json({ ok: true, success: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/send-ptt', (req, res) => { req.body.ptt = true; return app.handle(req, res); });

// ENVIAR IMAGEM
app.post('/send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });
    const result = await sock.sendMessage(formatPhone(to), {
      image: Buffer.from(image, 'base64'),
      caption: caption || '',
    });
    res.json({ ok: true, success: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ENVIAR DOCUMENTO
app.post('/send-document', async (req, res) => {
  try {
    const { to, document, filename, mimetype } = req.body;
    if (!isConnected) return res.status(503).json({ ok: false, error: 'Desconectado' });
    const result = await sock.sendMessage(formatPhone(to), {
      document: Buffer.from(document, 'base64'),
      fileName: filename || 'documento',
      mimetype: mimetype || 'application/octet-stream',
    });
    res.json({ ok: true, success: true, id: result?.key?.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// LOGOUT
app.post('/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
    isConnected = false; qrCode = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => { console.log(`Servidor rodando na porta ${PORT}`); connectWhatsApp(); });
