// servidor.js - WhatsApp Server V4 Always-On com Mídia Persistente
// Para deploy no Render.com com Dockerfile

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Timeout de 60 segundos para todas as requisições
app.use((req, res, next) => {
    req.setTimeout(60000);
    res.setTimeout(60000);
    next();
});

const PORT = process.env.PORT || 3000;

// Detectar ambiente de persistência
const PERSISTENT_DISK = fs.existsSync('/var/data') ? '/var/data' : './data';
const AUTH_FOLDER = path.join(PERSISTENT_DISK, 'auth_info');
const MEDIA_FOLDER = path.join(PERSISTENT_DISK, 'media');

// Criar pastas se não existirem
[AUTH_FOLDER, MEDIA_FOLDER].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
        console.log(`📁 Pasta criada: ${folder}`);
    }
});

console.log(`💾 Usando storage persistente em: ${PERSISTENT_DISK}`);

// ============================================
// KEEP-ALIVE - Evita hibernação no Render Free
// ============================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;

if (SELF_URL) {
    setInterval(async () => {
        try {
            const response = await fetch(`${SELF_URL}/health`);
            console.log(`🏓 Keep-alive ping: ${response.status}`);
        } catch (error) {
            console.log(`⚠️ Keep-alive falhou:`, error.message);
        }
    }, 4 * 60 * 1000); // Ping a cada 4 minutos
    console.log(`🔄 Keep-alive ativado para: ${SELF_URL}`);
} else {
    console.log(`⚠️ SELF_URL não configurada - servidor pode hibernar`);
}

// ============================================
// Estado Global
// ============================================
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let lastConnectedAt = null;
let messages = [];
const MAX_MESSAGES = 500;
const mediaCache = new Map();

// ============================================
// Funções Utilitárias
// ============================================
function log(type, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${type}] ${message}`;
    console.log(logMessage, data ? JSON.stringify(data).substring(0, 200) : '');
}

function formatPhoneNumber(jid) {
    if (!jid) return '';
    return jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

function generateMediaId() {
    return `media_${Date.now()}_${uuidv4().substring(0, 8)}`;
}

function getExtensionFromMimetype(mimetype) {
    const mimeMap = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'video/quicktime': 'mov',
        'audio/ogg; codecs=opus': 'ogg',
        'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a',
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    };
    return mimeMap[mimetype] || 'bin';
}

function getMediaUrl(filename) {
    const baseUrl = SELF_URL || `http://localhost:${PORT}`;
    return `${baseUrl}/media/${filename}`;
}

// ============================================
// Download e Salvamento de Mídia Persistente
// ============================================
async function downloadAndSaveMedia(message) {
    try {
        const msg = message.message;
        if (!msg) return null;

        let mediaType = null;
        let mediaData = null;

        if (msg.imageMessage) {
            mediaType = 'image';
            mediaData = msg.imageMessage;
        } else if (msg.videoMessage) {
            mediaType = 'video';
            mediaData = msg.videoMessage;
        } else if (msg.audioMessage) {
            mediaType = 'audio';
            mediaData = msg.audioMessage;
        } else if (msg.stickerMessage) {
            mediaType = 'sticker';
            mediaData = msg.stickerMessage;
        } else if (msg.documentMessage) {
            mediaType = 'document';
            mediaData = msg.documentMessage;
        }

        if (!mediaType || !mediaData) return null;

        log('MEDIA', `Baixando ${mediaType}...`);

        // Download do buffer
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
            }
        );

        if (!buffer || buffer.length === 0) {
            log('MEDIA', 'Buffer vazio');
            return null;
        }

        // Gerar nome único e salvar
        const extension = getExtensionFromMimetype(mediaData.mimetype);
        const mediaId = generateMediaId();
        const filename = `${mediaId}.${extension}`;
        const filepath = path.join(MEDIA_FOLDER, filename);

        fs.writeFileSync(filepath, buffer);
        log('MEDIA', `Salvo: ${filename} (${buffer.length} bytes)`);

        // Cache info
        const mediaInfo = {
            id: mediaId,
            filename,
            filepath,
            url: `/media/${filename}`,
            fullUrl: getMediaUrl(filename),
            type: mediaType,
            mimetype: mediaData.mimetype,
            size: buffer.length,
            caption: mediaData.caption || '',
            createdAt: new Date().toISOString()
        };

        mediaCache.set(mediaId, mediaInfo);
        
        return mediaInfo;

    } catch (error) {
        log('MEDIA_ERROR', error.message);
        return null;
    }
}

// Limpar mídias antigas (mais de 7 dias)
function cleanupOldMedia() {
    try {
        const files = fs.readdirSync(MEDIA_FOLDER);
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 dias

        files.forEach(file => {
            const filepath = path.join(MEDIA_FOLDER, file);
            const stats = fs.statSync(filepath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filepath);
                log('CLEANUP', `Removido: ${file}`);
            }
        });
    } catch (error) {
        log('CLEANUP_ERROR', error.message);
    }
}

// Executar limpeza diariamente
setInterval(cleanupOldMedia, 24 * 60 * 60 * 1000);

// ============================================
// Conexão WhatsApp
// ============================================
async function connectWhatsApp() {
    try {
        log('CONNECT', 'Iniciando conexão...');
        
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Voxy CRM', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 2000,
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                try {
                    qrCode = await QRCode.toDataURL(qr);
                    connectionStatus = 'waiting_qr';
                    log('QR', 'QR Code gerado');
                } catch (err) {
                    log('QR_ERROR', err.message);
                }
            }
            
            if (connection === 'close') {
                qrCode = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = DisconnectReason[statusCode] || statusCode;
                
                log('DISCONNECT', `Desconectado: ${reason}`);
                connectionStatus = 'disconnected';
                
                // Reconectar automaticamente (exceto logout manual)
                if (statusCode !== DisconnectReason.loggedOut) {
                    const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
                    log('RECONNECT', `Reconectando em ${delay/1000}s...`);
                    setTimeout(connectWhatsApp, delay);
                } else {
                    log('LOGOUT', 'Logout manual - limpando credenciais');
                    try {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
                    } catch (e) {}
                }
            }
            
            if (connection === 'open') {
                qrCode = null;
                connectionStatus = 'connected';
                lastConnectedAt = new Date().toISOString();
                log('CONNECTED', 'WhatsApp conectado!');
            }
        });

        // Receber mensagens
        sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
            if (type !== 'notify') return;
            
            for (const msg of newMessages) {
                if (!msg.message) continue;
                
                const jid = msg.key.remoteJid;
                if (jid === 'status@broadcast') continue;
                
                const fromMe = msg.key.fromMe;
                const pushName = msg.pushName || '';
                const timestamp = msg.messageTimestamp;
                
                // Extrair conteúdo da mensagem
                let content = '';
                let mediaInfo = null;
                const msgContent = msg.message;
                
                if (msgContent.conversation) {
                    content = msgContent.conversation;
                } else if (msgContent.extendedTextMessage?.text) {
                    content = msgContent.extendedTextMessage.text;
                } else if (msgContent.imageMessage || msgContent.videoMessage || 
                           msgContent.audioMessage || msgContent.stickerMessage ||
                           msgContent.documentMessage) {
                    // Baixar e salvar mídia
                    mediaInfo = await downloadAndSaveMedia(msg);
                    if (mediaInfo) {
                        content = mediaInfo.caption || `[${mediaInfo.type}]`;
                    }
                }
                
                const processedMessage = {
                    id: msg.key.id,
                    from: formatPhoneNumber(jid),
                    jid: jid,
                    fromMe,
                    pushName,
                    content,
                    timestamp: typeof timestamp === 'number' ? timestamp : parseInt(timestamp),
                    type: mediaInfo?.type || 'text',
                    media: mediaInfo ? {
                        url: mediaInfo.url,
                        fullUrl: mediaInfo.fullUrl,
                        type: mediaInfo.type,
                        mimetype: mediaInfo.mimetype,
                        filename: mediaInfo.filename,
                        size: mediaInfo.size
                    } : null
                };
                
                messages.unshift(processedMessage);
                if (messages.length > MAX_MESSAGES) {
                    messages = messages.slice(0, MAX_MESSAGES);
                }
                
                log('MESSAGE', `${fromMe ? 'Enviada' : 'Recebida'}: ${content.substring(0, 50)}...`);
            }
        });

        return sock;
    } catch (error) {
        log('CONNECT_ERROR', error.message);
        setTimeout(connectWhatsApp, 10000);
    }
}

// ============================================
// Rotas da API
// ============================================

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Status completo
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        hasQR: !!qrCode,
        lastConnectedAt,
        messagesCount: messages.length,
        mediaCount: mediaCache.size,
        storage: PERSISTENT_DISK,
        uptime: process.uptime()
    });
});

// Obter QR Code
app.get('/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ success: true, connected: true, message: 'Já conectado' });
    }
    if (qrCode) {
        return res.json({ success: true, qrCode, status: connectionStatus });
    }
    res.json({ success: false, message: 'QR não disponível', status: connectionStatus });
});

// Listar mensagens
app.get('/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json({
        success: true,
        messages: messages.slice(0, limit),
        total: messages.length
    });
});

// Servir mídia persistente
app.get('/media/:filename', (req, res) => {
    const { filename } = req.params;
    const filepath = path.join(MEDIA_FOLDER, filename);
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Mídia não encontrada' });
    }
    
    // Detectar mimetype
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.ogg': 'audio/ogg',
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.pdf': 'application/pdf',
    };
    
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 dias
    res.sendFile(filepath);
});

// Enviar mensagem de texto
app.post('/send', async (req, res) => {
    try {
        const { to, message } = req.body;
        
        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp não conectado' });
        }
        
        if (!to || !message) {
            return res.status(400).json({ error: 'Parâmetros "to" e "message" obrigatórios' });
        }
        
        const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        log('SEND', `Mensagem enviada para ${to}`);
        res.json({ success: true, to, message: 'Enviado' });
    } catch (error) {
        log('SEND_ERROR', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Enviar imagem
app.post('/send-image', async (req, res) => {
    try {
        const { to, imageUrl, imageBase64, caption } = req.body;
        
        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp não conectado' });
        }
        
        const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        
        let imageBuffer;
        if (imageBase64) {
            imageBuffer = Buffer.from(imageBase64, 'base64');
        } else if (imageUrl) {
            const response = await fetch(imageUrl);
            imageBuffer = Buffer.from(await response.arrayBuffer());
        } else {
            return res.status(400).json({ error: 'imageUrl ou imageBase64 obrigatório' });
        }
        
        await sock.sendMessage(jid, { 
            image: imageBuffer, 
            caption: caption || '' 
        });
        
        res.json({ success: true, to, type: 'image' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enviar áudio
app.post('/send-audio', async (req, res) => {
    try {
        const { to, audioUrl, audioBase64 } = req.body;
        
        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp não conectado' });
        }
        
        const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        
        let audioBuffer;
        if (audioBase64) {
            audioBuffer = Buffer.from(audioBase64, 'base64');
        } else if (audioUrl) {
            const response = await fetch(audioUrl);
            audioBuffer = Buffer.from(await response.arrayBuffer());
        } else {
            return res.status(400).json({ error: 'audioUrl ou audioBase64 obrigatório' });
        }
        
        await sock.sendMessage(jid, { 
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: true // Voice note
        });
        
        res.json({ success: true, to, type: 'audio' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enviar vídeo
app.post('/send-video', async (req, res) => {
    try {
        const { to, videoUrl, videoBase64, caption } = req.body;
        
        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp não conectado' });
        }
        
        const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        
        let videoBuffer;
        if (videoBase64) {
            videoBuffer = Buffer.from(videoBase64, 'base64');
        } else if (videoUrl) {
            const response = await fetch(videoUrl);
            videoBuffer = Buffer.from(await response.arrayBuffer());
        } else {
            return res.status(400).json({ error: 'videoUrl ou videoBase64 obrigatório' });
        }
        
        await sock.sendMessage(jid, { 
            video: videoBuffer,
            caption: caption || ''
        });
        
        res.json({ success: true, to, type: 'video' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enviar documento
app.post('/send-document', async (req, res) => {
    try {
        const { to, documentUrl, documentBase64, filename, mimetype } = req.body;
        
        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp não conectado' });
        }
        
        const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        
        let docBuffer;
        if (documentBase64) {
            docBuffer = Buffer.from(documentBase64, 'base64');
        } else if (documentUrl) {
            const response = await fetch(documentUrl);
            docBuffer = Buffer.from(await response.arrayBuffer());
        } else {
            return res.status(400).json({ error: 'documentUrl ou documentBase64 obrigatório' });
        }
        
        await sock.sendMessage(jid, { 
            document: docBuffer,
            mimetype: mimetype || 'application/pdf',
            fileName: filename || 'documento.pdf'
        });
        
        res.json({ success: true, to, type: 'document' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        qrCode = null;
        connectionStatus = 'disconnected';
        messages = [];
        
        // Limpar credenciais
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        
        res.json({ success: true, message: 'Deslogado' });
        
        // Reconectar para gerar novo QR
        setTimeout(connectWhatsApp, 2000);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp Server V4 - Always On',
        version: '4.0.0',
        status: connectionStatus,
        features: [
            'Mídia persistente (7 dias)',
            'Auto-reconexão',
            'Keep-alive anti-hibernação',
            'QR Code local'
        ],
        endpoints: {
            status: '/status',
            qr: '/qr',
            messages: '/messages',
            media: '/media/:filename',
            send: 'POST /send',
            sendImage: 'POST /send-image',
            sendAudio: 'POST /send-audio',
            sendVideo: 'POST /send-video',
            sendDocument: 'POST /send-document',
            logout: 'POST /logout'
        }
    });
});

// ============================================
// Inicialização
// ============================================
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║   WhatsApp Server V4 - Always On               ║
║   Porta: ${PORT}                                    ║
║   Storage: ${PERSISTENT_DISK.padEnd(32)}║
╚════════════════════════════════════════════════╝
    `);
    connectWhatsApp();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('SHUTDOWN', 'Desligando servidor...');
    if (sock) sock.end();
    process.exit(0);
});
