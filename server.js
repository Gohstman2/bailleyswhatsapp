import express from 'express';
import P from 'pino';
import QRCode from 'qrcode';
import { default as makeWASocket, useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';

const app = express();
app.use(express.json());
const PORT = 3000;

// Stockage global du client
let client = null;

// Initialise le client WhatsApp
async function initClient() {
  if (!client) {
    const { state, saveCreds } = await useSingleFileAuthState('./auth_info.json');
    const { version } = await fetchLatestBaileysVersion();

    client = makeWASocket({
      auth: state,
      logger: P({ level: 'debug' }),
      version,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
    });

    client.ev.on('creds.update', saveCreds);

    client.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        client.qrCode = qr;
      }

      if (connection === 'close') {
        if ((lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
          console.log('Reconnexion...');
          client = null;
          initClient();
        }
      }
    });
  }
}

// Route pour auth : retourne QR code ou statut authenticated
app.get('/auth', async (req, res) => {
  await initClient();

  if (client.user) {
    return res.json({ status: 'authenticated', user: client.user });
  }

  if (client.qrCode) {
    const qrDataUrl = await QRCode.toDataURL(client.qrCode);
    return res.json({ status: 'qr', qr: qrDataUrl });
  }

  return res.json({ status: 'waiting' });
});

// Route pour envoyer un message
app.post('/sendmessage', async (req, res) => {
  const { number, message } = req.body;

  if (!client || !client.user) {
    return res.status(400).json({ error: 'Client non authentifié' });
  }

  if (!number || !message) {
    return res.status(400).json({ error: 'Numéro ou message manquant' });
  }

  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

  try {
    await client.sendMessage(jid, { text: message });
    res.json({ status: 'success', to: number });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
