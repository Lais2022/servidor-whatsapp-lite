import express from "express";
import cors from "cors";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let sock = null;
let isConnected = false;
let lastQr = null;
let messages = [];

function pushMessage(msg) {
  messages.unshift(msg);
  messages = messages.slice(0, 200);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server on port", port));

start().catch((e) => {
  console.error("start error:", e);
  process.exit(1);
});
