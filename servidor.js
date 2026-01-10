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

// IMPORTANTE: Use /var/data se tiver Persistent Disk no Render
// Caso contrário, use ./auth_info (mas vai perder sessão em restart)
const AUTH_FOLDER = process.env.AUTH_PATH || '/var/data/auth_info';

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' })); // Suporta áudio/imagens grandes

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

/**
 * Formata telefone para JID do WhatsApp
 * Aceita: número puro, @s.whatsapp.net, @c.us, @lid
 */
const formatPhone = (phone) => {
  if (!phone) return null;
  
  // Se já é um JID completo, retorna como está
  if (phone.includes('@')) return phone;
  
  // Remove tudo que não é número
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  
  return `${digits}@s.whatsapp.net`;
};

/**
 * Adiciona mensagem ao histórico (limite de MAX_MESSAGES)
 */
const addMessage = (msg) => {
  messages.unshift(msg);
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(0, MAX_MESSAGES);
  }
};

/**
 * Log com timestamp
 */
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

    // Carrega credenciais salvas (se existirem)
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    log('info', 'connect', `Iniciando conexão com Baileys v${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: true, // Mostra QR no terminal também
      logger,
      browser: ['WhatsApp Server', 'Chrome', '22.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    // ========== EVENTOS DE CONEXÃO ==========
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code recebido
      if (qr) {
        qrCode = qr;
        isConnected = false;
        log('info', 'qr', 'Novo QR Code gerado. Escaneie com o WhatsApp.');
      }

      // Conexão fechada
      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        qrCode = null;

        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const reasonName = DisconnectReason[reason] || reason;

        log('warn', 'disconnect', `Conexão fechada. Motivo: ${reasonName} (${reason})`);

        // Decide se reconecta automaticamente
        if (reason === DisconnectReason.loggedOut) {
          // Logout explícito - limpa credenciais
          log('info', 'logout', 'Logout detectado. Limpando credenciais...');
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          } catch (e) {
            log('error', 'cleanup', `Erro ao limpar auth: ${e.message}`);
          }
          connectionError = 'Deslogado. Escaneie o QR Code novamente.';
        } else if (reason === DisconnectReason.restartRequired) {
          // Restart necessário
          log('info', 'restart', 'Restart necessário. Reconectando em 1s...');
          setTimeout(connectWhatsApp, 1000);
        } else if (reason === DisconnectReason.connectionClosed ||
                   reason === DisconnectReason.connectionLost ||
                   reason === DisconnectReason.timedOut) {
          // Conexão perdida - reconecta
          log('info', 'reconnect', 'Conexão perdida. Reconectando em 3s...');
          setTimeout(connectWhatsApp, 3000);
        } else {
          // Outros motivos - tenta reconectar
          log('info', 'reconnect', `Tentando reconectar em 5s...`);
          setTimeout(connectWhatsApp, 5000);
        }
      }

      // Conexão aberta com sucesso
      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        qrCode = null;
        connectionError = null;
        log('success', 'connect', 'WhatsApp conectado com sucesso!');
      }
    });

    // ========== SALVAR CREDENCIAIS ==========
    sock.ev.on('creds.update', saveCreds);

    // ========== RECEBER MENSAGENS ==========
    sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
      if (type !== 'notify') return;

      for (const msg of newMessages) {
        if (!msg.message) continue;

        const from = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;

        // Ignora grupos e status
        if (from === 'status@broadcast' || from?.endsWith('@g.us')) continue;

        // Extrai texto da mensagem
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption ||
          '';

        // Extrai nome do contato
        const pushName = msg.pushName || '';

        // Timestamp
        const timestamp = msg.messageTimestamp
          ? (typeof msg.messageTimestamp === 'number'
              ? msg.messageTimestamp * 1000
              : Number(msg.messageTimestamp) * 1000)
          : Date.now();

        // Tipo da mensagem
        const msgType = Object.keys(msg.message)[0];

        const parsed = {
          id: msg.key.id,
          from,
          fromMe,
          text,
          name: pushName,
          timestamp,
          type: msgType,
          raw: msg, // Guarda original para debug
        };

        addMessage(parsed);
        log('info', 'message', `${fromMe ? 'ENVIADA' : 'RECEBIDA'} de ${from}: ${text.slice(0, 50)}...`);
      }
    });

  } catch (error) {
    isConnecting = false;
    connectionError = error.message;
    log('error', 'connect', `Erro ao conectar: ${error.message}`);
    
    // Tenta novamente em 10s
    setTimeout(connectWhatsApp, 10000);
  }
}

// ============================================================
// ROTAS DA API
// ============================================================

// ---------- HEALTH CHECK ----------
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

// ---------- STATUS ----------
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

// ---------- QR CODE ----------
app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.json({ qr: null, connected: true, message: 'Já conectado' });
  }

  if (isConnecting && !qrCode) {
    return res.json({ qr: null, connecting: true, message: 'Gerando QR Code...' });
  }

  res.json({ qr: qrCode || null });
});

// ---------- MENSAGENS ----------
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ messages: messages.slice(0, limit) });
});

// ============================================================
// ENVIO DE MENSAGENS
// ============================================================

// ---------- ENVIAR TEXTO ----------
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

// ---------- ENVIAR ÁUDIO (PTT / Voice Message) ----------
// IMPORTANTE: WhatsApp só aceita audio/ogg; codecs=opus ou audio/mp4
// Navegadores gravam em webm, então o servidor precisa converter!
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

    // Decodifica base64 para buffer
    let audioBuffer = Buffer.from(audio, 'base64');
    let finalMimetype = 'audio/ogg; codecs=opus';

    const inputMimetype = (mimetype || '').toLowerCase();
    const isWebm = inputMimetype.includes('webm');
    
    log('info', 'send-audio', `Recebido áudio (${Math.round(audioBuffer.length / 1024)}KB, ${inputMimetype}) para ${jid}`);

    // Se for webm, tenta converter para ogg usando ffmpeg
    if (isWebm) {
      try {
        const { execSync } = require('child_process');
        const os = require('os');
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `audio_${Date.now()}.webm`);
        const outputPath = path.join(tmpDir, `audio_${Date.now()}.ogg`);
        
        // Salva arquivo temporário
        fs.writeFileSync(inputPath, audioBuffer);
        
        // Converte com ffmpeg (precisa estar instalado no Render - veja instruções)
        // Comando: ffmpeg -i input.webm -c:a libopus output.ogg
        execSync(`ffmpeg -i "${inputPath}" -c:a libopus -b:a 64k "${outputPath}" -y`, {
          timeout: 30000,
          stdio: 'pipe',
        });
        
        // Lê arquivo convertido
        audioBuffer = fs.readFileSync(outputPath);
        finalMimetype = 'audio/ogg; codecs=opus';
        
        // Limpa arquivos temporários
        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
        
        log('success', 'send-audio', `Áudio convertido de webm para ogg (${Math.round(audioBuffer.length / 1024)}KB)`);
        
      } catch (conversionError) {
        // Se ffmpeg falhar, tenta enviar assim mesmo (alguns WhatsApp aceitam)
        log('warn', 'send-audio', `Conversão falhou (${conversionError.message}), tentando enviar webm diretamente...`);
        // Usa mp4 como fallback - WhatsApp às vezes aceita
        finalMimetype = 'audio/mp4';
      }
    } else if (inputMimetype.includes('ogg') || inputMimetype.includes('opus')) {
      finalMimetype = 'audio/ogg; codecs=opus';
    } else if (inputMimetype.includes('mp4') || inputMimetype.includes('m4a')) {
      finalMimetype = 'audio/mp4';
    }

    log('info', 'send-audio', `Enviando áudio como ${finalMimetype} (${Math.round(audioBuffer.length / 1024)}KB) para ${jid}`);

    // Envia como PTT (mensagem de voz)
    const result = await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: finalMimetype,
      ptt: ptt !== false, // true por padrão = mensagem de voz (bolinha verde)
    });

    log('success', 'send-audio', `Áudio enviado. ID: ${result?.key?.id}`);
    res.json({ ok: true, success: true, id: result?.key?.id });

  } catch (error) {
    log('error', 'send-audio', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Alias /send-ptt -> /send-audio com ptt=true
app.post('/send-ptt', async (req, res) => {
  req.body.ptt = true;
  // Chama o handler de /send-audio
  return app._router.handle({ ...req, url: '/send-audio', originalUrl: '/send-audio' }, res, () => {});
});

// ---------- ENVIAR IMAGEM ----------
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

// ---------- ENVIAR VÍDEO ----------
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

// ---------- ENVIAR DOCUMENTO ----------
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

// ---------- ENVIAR MÍDIA GENÉRICO ----------
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

// ---------- LOGOUT / DESCONECTAR ----------
app.post('/logout', async (req, res) => {
  try {
    log('info', 'logout', 'Executando logout...');

    if (sock) {
      await sock.logout();
    }

    isConnected = false;
    isConnecting = false;
    qrCode = null;

    // Limpa credenciais
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

// ---------- RECONECTAR ----------
app.post('/reconnect', async (req, res) => {
  try {
    log('info', 'reconnect', 'Forçando reconexão...');

    if (sock) {
      sock.end();
    }

    isConnected = false;
    isConnecting = false;
    qrCode = null;

    // Inicia nova conexão
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

  // Inicia conexão ao WhatsApp automaticamente
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
