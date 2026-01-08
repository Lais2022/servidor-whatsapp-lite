import express from "express";
import cors from "cors";
import fs from "fs";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const AUTH_DIR = "./auth";

let sock = null;
let isConnected = false;
let lastQr = null;
let messages = [];

function pushMessage(msg) {
  messages.unshift(msg);
  messages = messages.slice(0, 200);
}

function resetAuthFolder() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {}
}

async function closeSock() {
  try { sock?.end?.(); } catch {}
  try { sock?.ws?.close?.(); } catch {}
  sock = null;
  isConnected = false;
  lastQr = null;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) lastQr = qr;

    if (connection === "open") {
      isConnected = true;
      lastQr = null;
      console.log("WhatsApp conectado");
    }

    if (connection === "close") {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("Conexao fechada. code=", code, "reconnect=", shouldReconnect);
      if (shouldReconnect) start();
    }
  });

  sock.ev.on("messages.upsert", ({ messages: ms }) => {
    for (const m of ms) {
      const text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        "";

      pushMessage({
        id: m.key.id,
        from: m.key.remoteJid,
        fromMe: !!m.key.fromMe,
        text,
        timestamp: Date.now()
      });
    }
  });
}

// ========== ENDPOINTS ==========

app.get("/status", (req, res) => {
  res.json({ ok: true, connected: isConnected });
});

app.get("/qr", (req, res) => {
  res.json({ qr: lastQr });
});

app.get("/messages", (req, res) => {
  res.json({ messages });
});

app.post("/send", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!sock) return res.status(400).json({ ok: false, error: "sock_not_ready" });
    if (!to || !text) return res.status(400).json({ ok: false, error: "missing_to_or_text" });

    const jid = to.includes("@s.whatsapp.net") ? to : to + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: String(text) });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// NOVO: Desconectar (mantém auth)
app.post("/disconnect", async (req, res) => {
  try {
    await closeSock();
    start().catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// NOVO: Logout (apaga auth, gera QR novo)
app.post("/logout", async (req, res) => {
  try {
    try { await sock?.logout?.(); } catch {}
    await closeSock();
    resetAuthFolder();
    start().catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// NOVO: Reset completo (força novo QR)
app.post("/reset", async (req, res) => {
  try {
    await closeSock();
    resetAuthFolder();
    start().catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server on port", port));

start().catch((e) => {
  console.error("start error:", e);
  process.exit(1);
});
