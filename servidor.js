// ============================================================
// WHATSAPP SERVER - VERSÃO DEFINITIVA PARA RENDER
// ============================================================
// 
// INSTRUÇÕES DE DEPLOY NO RENDER:
// 
// 1) Crie um novo "Web Service" no Render
// 2) Conecte seu repositório ou use "Deploy from URL"
// 3) Configure assim:
//    - Build Command: npm install
//    - Start Command: node servidor.js
//    - Environment: Node
// 
// 4) IMPORTANTE - PERSISTENT DISK (para não perder sessão):
//    No Render, vá em: Service > Disks > Add Disk
//    - Name: whatsapp-auth
//    - Mount Path: /var/data
//    - Size: 1 GB (mínimo)
//    
//    Isso garante que a sessão NÃO será perdida em restarts!
//
// 5) Variáveis de ambiente (opcional):
//    - PORT: 3000 (padrão)
//    - AUTH_PATH: /var/data/auth_info (se usar Persistent Disk)
//
// 6) package.json mínimo:
//    {
//      "name": "whatsapp-server",
//      "version": "1.0.0",
//      "main": "servidor.js",
//      "scripts": {
//        "start": "node servidor.js"
//      },
//      "dependencies": {
//        "express": "^4.18.2",
//        "cors": "^2.8.5",
//        "@whiskeysockets/baileys": "^6.7.16",
//        "@hapi/boom": "^10.0.1",
//        "pino": "^9.6.0"
//      }
//    }
//
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Baileys - biblioteca WhatsApp
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANTE: No plano gratuito do Render, use ./auth_info (local)
// Com Persistent Disk (pago), pode usar /var/data/auth_info
// Detecta automaticamente se /var/data existe (Persistent Disk)
const AUTH_FOLDER = process.env.AUTH_PATH || (
  fs.existsSync('/var/data') ? '/var/data/auth_info' : './auth_info'
);

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));

// Logger (silencioso para não poluir logs do Render)
const logger = pino({ level: 'warn' });

// ============================================================
// ESTADO GLOBAL
// ============================================================

let sock = null;
let qrCode = null;
let isConnected = false;
let isConnecting = false;
let connectionError = null;
let messages = [];
const MAX_MESSAGES = 200;

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

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

// ============================================================
// CONEXÃO WHATSAPP (BAILEYS)
// ============================================================

async function connectWhatsApp() {
  if (isConnecting) {
    log('warn', 'connect', 'Já está conectando, aguarde...');
    return;
  }

  isConnecting = true;
  connectionError = null;

  try {
    // Cria pasta de autenticação se não existir
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      log('info', 'auth', `Pasta de auth criada: ${AUTH_FOLDER}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    log('info', 'connect', `Iniciando conexão com Baileys v${version.join('.')}`);

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
        log('info', 'qr', 'Novo QR Code gerado. Escaneie com o WhatsApp.');
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        qrCode = null;

        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const reasonName = DisconnectReason[reason] || reason;

        log('warn', 'disconnect', `Conexão fechada. Motivo: ${reasonName} (${reason})`);

        if (reason === DisconnectReason.loggedOut) {
          log('info', 'logout', 'Logout detectado. Limpando credenciais...');
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          } catch (e) {
            log('error', 'cleanup', `Erro ao limpar auth: ${e.message}`);
          }
          connectionError = 'Deslogado. Escaneie o QR Code novamente.';
        } else if (reason === DisconnectReason.restartRequired) {
          log('info', 'restart', 'Restart necessário. Reconectando em 1s...');
          setTimeout(connectWhatsApp, 1000);
        } else if (reason === DisconnectReason.connectionClosed ||
                   reason === DisconnectReason.connectionLost ||
                   reason === DisconnectReason.timedOut) {
          log('info', 'reconnect', 'Conexão perdida. Reconectando em 3s...');
          setTimeout(connectWhatsApp, 3000);
        } else {
          log('info', 'reconnect', `Tentando reconectar em 5s...`);
          setTimeout(connectWhatsApp, 5000);
        }
      }

      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        qrCode = null;
        connectionError = null;
        log('success', 'connect', 'WhatsApp conectado com sucesso!');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
      if (type !== 'notify') return;

      for (const msg of newMessages) {
        if (!msg.message) continue;

        const from = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;

        if (from === 'status@broadcast' || from?.endsWith('@g.us')) continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption ||
          '';

        const pushName = msg.pushName || '';

        const timestamp = msg.messageTimestamp
          ? (typeof msg.messageTimestamp === 'number'
              ? msg.messageTimestamp * 1000
              : Number(msg.messageTimestamp) * 1000)
          : Date.now();

        const msgType = Object.keys(msg.message)[0];

        const parsed = {
          id: msg.key.id,
          from,
          fromMe,
          text,
          name: pushName,
          timestamp,
          type: msgType,
          raw: msg,
        };

        addMessage(parsed);
        log('info', 'message', `${fromMe ? 'ENVIADA' : 'RECEBIDA'} de ${from}: ${text.slice(0, 50)}...`);
      }
    });

  } catch (error) {
    isConnecting = false;
    connectionError = error.message;
    log('error', 'connect', `Erro ao conectar: ${error.message}`);
    setTimeout(connectWhatsApp, 10000);
  }
}

// ============================================================
// ROTAS DA API
// ============================================================

app.get('/', (req, res) => {
  res.json({
    ok: true,
    server: 'whatsapp-server-render',
    version: '2.0.0',
    connected: isConnected,
    connecting: isConnecting,
    hasQR: !!qrCode,
    authPath: AUTH_FOLDER,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    connected: isConnected,
    ready: isConnected,
    authenticated: isConnected,
    connecting: isConnecting,
    error: connectionError,
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.json({ qr: null, connected: true, message: 'Já conectado' });
  }
  if (isConnecting && !qrCode) {
    return res.json({ qr: null, connecting: true, message: 'Gerando QR Code...' });
  }
  res.json({ qr: qrCode || null });
});

app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ messages: messages.slice(0, limit) });
});

// ============================================================
// ENVIO DE MENSAGENS
// ============================================================

app.post('/send', async (req, res) => {
  try {
    const { to, text, message } = req.body;
    const content = text || message;

    if (!to || !content) {
      return res.status(400).json({ ok: false, error: 'Faltando "to" ou "text"' });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({ ok: false, error: 'Desconectado' });
    }

    const jid = formatPhone(to);
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'Telefone inválido' });
    }

    log('info', 'send', `Enviando texto para ${jid}: ${content.slice(0, 50)}...`);
    const result = await sock.sendMessage(jid, { text: content });

    log('success', 'send', `Texto enviado. ID: ${result?.key?.id}`);
    res.json({ ok: true, success: true, id: result?.key?.id });

  } catch (error) {
    log('error', 'send', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-audio', async (req, res) => {
  try {
    const { to, audio, mimetype, ptt } = req.body;

    if (!to || !audio) {
      return res.status(400).json({ ok: false, error: 'Faltando "to" ou "audio"' });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({ ok: false, error: 'Desconectado' });
    }

    const jid = formatPhone(to);
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'Telefone inválido' });
    }

    let audioBuffer = Buffer.from(audio, 'base64');
    let finalMimetype = 'audio/ogg; codecs=opus';

    const inputMimetype = (mimetype || '').toLowerCase();
    const isWebm = inputMimetype.includes('webm');
    
    log('info', 'send-audio', `Recebido áudio (${Math.round(audioBuffer.length / 1024)}KB, ${inputMimetype}) para ${jid}`);

    if (isWebm) {
      try {
        const { execSync } = require('child_process');
        const os = require('os');
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `audio_${Date.now()}.webm`);
        const outputPath = path.join(tmpDir, `audio_${Date.now()}.ogg`);
        
        fs.writeFileSync(inputPath, audioBuffer);
        
        execSync(`ffmpeg -i "${inputPath}" -c:a libopus -b:a 64k "${outputPath}" -y`, {
          timeout: 30000,
          stdio: 'pipe',
        });
        
        audioBuffer = fs.readFileSync(outputPath);
        finalMimetype = 'audio/ogg; codecs=opus';
        
        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
        
        log('success', 'send-audio', `Áudio convertido de webm para ogg (${Math.round(audioBuffer.length / 1024)}KB)`);
        
      } catch (conversionError) {
        log('warn', 'send-audio', `Conversão falhou (${conversionError.message}), tentando enviar webm diretamente...`);
        finalMimetype = 'audio/mp4';
      }
    } else if (inputMimetype.includes('ogg') || inputMimetype.includes('opus')) {
      finalMimetype = 'audio/ogg; codecs=opus';
    } else if (inputMimetype.includes('mp4') || inputMimetype.includes('m4a')) {
      finalMimetype = 'audio/mp4';
    }

    log('info', 'send-audio', `Enviando áudio como ${finalMimetype} (${Math.round(audioBuffer.length / 1024)}KB) para ${jid}`);

    const result = await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: finalMimetype,
      ptt: ptt !== false,
    });

    log('success', 'send-audio', `Áudio enviado. ID: ${result?.key?.id}`);
    res.json({ ok: true, success: true, id: result?.key?.id });

  } catch (error) {
    log('error', 'send-audio', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-ptt', async (req, res) => {
  req.body.ptt = true;
  return app._router.handle({ ...req, url: '/send-audio', originalUrl: '/send-audio' }, res, () => {});
});

app.post('/send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;

    if (!to || !image) {
      return res.status(400).json({ ok: false, error: 'Faltando "to" ou "image"' });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({ ok: false, error: 'Desconectado' });
    }

    const jid = formatPhone(to);
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'Telefone inválido' });
    }

    const imageBuffer = Buffer.from(image, 'base64');

    log('info', 'send-image', `Enviando imagem (${Math.round(imageBuffer.length / 1024)}KB) para ${jid}`);

    const result = await sock.sendMessage(jid, {
      image: imageBuffer,
      caption: caption || '',
    });

    log('success', 'send-image', `Imagem enviada. ID: ${result?.key?.id}`);
    res.json({ ok: true, success: true, id: result?.key?.id });

  } catch (error) {
    log('error', 'send-image', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-video', async (req, res) => {
  try {
    const { to, video, caption, mimetype } = req.body;

    if (!to || !video) {
      return res.status(400).json({ ok: false, error: 'Faltando "to" ou "video"' });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({ ok: false, error: 'Desconectado' });
    }

    const jid = formatPhone(to);
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'Telefone inválido' });
    }

    const videoBuffer = Buffer.from(video, 'base64');

    log('info', 'send-video', `Enviando vídeo (${Math.round(videoBuffer.length / 1024)}KB) para ${jid}`);

    const result = await sock.sendMessage(jid, {
      video: videoBuffer,
      caption: caption || '',
      mimetype: mimetype || 'video/mp4',
    });

    log('success', 'send-video', `Vídeo enviado. ID: ${result?.key?.id}`);
    res.json({ ok: true, success: true, id: result?.key?.id });

  } catch (error) {
    log('error', 'send-video', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-document', async (req, res) => {
  try {
    const { to, document, filename, mimetype } = req.body;

    if (!to || !document) {
      return res.status(400).json({ ok: false, error: 'Faltando "to" ou "document"' });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({ ok: false, error: 'Desconectado' });
    }

    const jid = formatPhone(to);
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'Telefone inválido' });
    }

    const docBuffer = Buffer.from(document, 'base64');

    log('info', 'send-document', `Enviando documento (${Math.round(docBuffer.length / 1024)}KB) para ${jid}`);

    const result = await sock.sendMessage(jid, {
      document: docBuffer,
      fileName: filename || 'documento',
      mimetype: mimetype || 'application/octet-stream',
    });

    log('success', 'send-document', `Documento enviado. ID: ${result?.key?.id}`);
    res.json({ ok: true, success: true, id: result?.key?.id });

  } catch (error) {
    log('error', 'send-document', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-media', async (req, res) => {
  try {
    const { to, media, type, mimetype, filename, caption } = req.body;

    if (!to || !media) {
      return res.status(400).json({ ok: false, error: 'Faltando "to" ou "media"' });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({ ok: false, error: 'Desconectado' });
    }

    const jid = formatPhone(to);
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'Telefone inválido' });
    }

    const buffer = Buffer.from(media, 'base64');
    let messageContent = {};

    switch (type) {
      case 'image':
        messageContent = { image: buffer, caption: caption || '' };
        break;
      case 'video':
        messageContent = { video: buffer, caption: caption || '', mimetype: mimetype || 'video/mp4' };
        break;
      case 'audio':
        messageContent = { audio: buffer, mimetype: mimetype || 'audio/ogg; codecs=opus', ptt: true };
        break;
      case 'document':
        messageContent = { document: buffer, fileName: filename || 'arquivo', mimetype: mimetype || 'application/octet-stream' };
        break;
      default:
        return res.status(400).json({ ok: false, error: 'Tipo inválido. Use: image, video, audio, document' });
    }

    log('info', 'send-media', `Enviando ${type} (${Math.round(buffer.length / 1024)}KB) para ${jid}`);

    const result = await sock.sendMessage(jid, messageContent);

    log('success', 'send-media', `${type} enviado. ID: ${result?.key?.id}`);
    res.json({ ok: true, success: true, id: result?.key?.id });

  } catch (error) {
    log('error', 'send-media', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// CONTROLE DE CONEXÃO
// ============================================================

app.post('/logout', async (req, res) => {
  try {
    log('info', 'logout', 'Executando logout...');

    if (sock) {
      await sock.logout();
    }

    isConnected = false;
    isConnecting = false;
    qrCode = null;

    try {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      log('info', 'logout', 'Credenciais removidas');
    } catch (e) {
      log('warn', 'logout', `Erro ao limpar auth: ${e.message}`);
    }

    res.json({ ok: true, message: 'Desconectado e credenciais removidas' });

  } catch (error) {
    log('error', 'logout', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/reconnect', async (req, res) => {
  try {
    log('info', 'reconnect', 'Forçando reconexão...');

    if (sock) {
      sock.end();
    }

    isConnected = false;
    isConnecting = false;
    qrCode = null;

    setTimeout(connectWhatsApp, 1000);

    res.json({ ok: true, message: 'Reconectando...' });

  } catch (error) {
    log('error', 'reconnect', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================

app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         WHATSAPP SERVER - VERSÃO DEFINITIVA                ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Porta:      ${PORT.toString().padEnd(46)}║`);
  console.log(`║  Auth Path:  ${AUTH_FOLDER.padEnd(46)}║`);
  console.log('║                                                            ║');
  console.log('║  Endpoints:                                                ║');
  console.log('║    GET  /         - Health check                           ║');
  console.log('║    GET  /status   - Status da conexão                      ║');
  console.log('║    GET  /qr       - QR Code para conexão                   ║');
  console.log('║    GET  /messages - Mensagens recentes                     ║');
  console.log('║    POST /send     - Enviar texto                           ║');
  console.log('║    POST /send-audio - Enviar áudio (PTT)                   ║');
  console.log('║    POST /send-image - Enviar imagem                        ║');
  console.log('║    POST /send-video - Enviar vídeo                         ║');
  console.log('║    POST /send-document - Enviar documento                  ║');
  console.log('║    POST /send-media - Enviar mídia genérica                ║');
  console.log('║    POST /logout   - Desconectar e limpar sessão            ║');
  console.log('║    POST /reconnect - Forçar reconexão                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  connectWhatsApp();
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.on('SIGTERM', () => {
  log('info', 'shutdown', 'Recebido SIGTERM, encerrando...');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'shutdown', 'Recebido SIGINT, encerrando...');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});
