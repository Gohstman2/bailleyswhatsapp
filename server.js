import express from 'express'
import axios from 'axios'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const authBaseDir = './auth_sessions'
const webhookBaseDir = './webhooks'

// Créer les dossiers si absents
if (!fs.existsSync(authBaseDir)) fs.mkdirSync(authBaseDir, { recursive: true })
if (!fs.existsSync(webhookBaseDir)) fs.mkdirSync(webhookBaseDir, { recursive: true })

// Stockage des sockets actifs par userId
const sockets = new Map()

// Envoi message à API externe
async function sendCodeToApi(destNumber, message) {
  try {
    const resp = await axios.post('https://senhatsappv3.onrender.com/sendMessage', {
      number: destNumber,
      message
    }, { timeout: 15000 })
    return resp.data
  } catch (e) {
    console.error('Erreur envoi message API externe:', e.message)
    throw e
  }
}

// Démarre ou récupère une session Baileys pour un utilisateur
async function getSocket(userId) {
  if (sockets.has(userId)) return sockets.get(userId)

  const sessionFolder = path.join(authBaseDir, userId)
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('WhatsApp-Bot')
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Convertir QR en base64 et envoyer au numéro userId (destinataire)
      const qrBase64 = await QRCode.toDataURL(qr)
      try {
        await sendCodeToApi(userId, `Scannez ce QR code pour connecter WhatsApp :\n${qrBase64}`)
      } catch (e) {
        console.error('Erreur envoi QR code:', e.message)
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      console.log(`Connection fermée pour ${userId}, code: ${statusCode}`)
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Tentative reconnexion...')
        sockets.delete(userId)
        await getSocket(userId)
      } else {
        console.log('Déconnecté volontairement pour', userId)
        sockets.delete(userId)
      }
    }

    if (connection === 'open') {
      console.log(`Connecté avec succès pour ${userId}`)
    }
  })

  // Gestion messages entrants
  sock.ev.on('messages.upsert', async (m) => {
    if (!m.messages || m.messages.length === 0) return

    const message = m.messages[0]
    const remoteJid = message.key.remoteJid

    // Lire webhook utilisateur
    const webhookFile = path.join(webhookBaseDir, userId + '.json')
    if (!fs.existsSync(webhookFile)) return // Pas de webhook défini

    const { url } = JSON.parse(fs.readFileSync(webhookFile))

    try {
      // Envoyer au webhook
      await axios.post(url, { message })
      console.log(`Message envoyé au webhook pour ${userId}`)

      // Supprimer message côté serveur
      await sock.sendMessage(remoteJid, { delete: message.key })
      console.log('Message supprimé côté serveur')
    } catch (e) {
      console.error('Erreur webhook ou suppression message:', e.message)
    }
  })

  sockets.set(userId, sock)
  return sock
}

// ROUTE - Auth via QR code (démarre session)
app.post('/auth/qr', async (req, res) => {
  const { userId } = req.body
  if (!userId) return res.status(400).json({ error: 'userId requis' })

  try {
    const sock = await getSocket(userId)
    res.json({ success: true, message: 'Session démarrée, QR code envoyé au webhook' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ROUTE - Auth via pairing code
app.post('/auth/pairing', async (req, res) => {
  const { userId, pairingCode, destNumber } = req.body
  if (!userId || !pairingCode || !destNumber) return res.status(400).json({ error: 'userId, pairingCode et destNumber requis' })

  try {
    const sessionFolder = path.join(authBaseDir, userId)
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder)

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS('WhatsApp-Bot')
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        console.log(`Connecté via pairing code pour ${userId}`)
      }
    })

    // Demande de pairing code
    const code = await sock.requestPairingCode(pairingCode)
    console.log(`Pairing code généré: ${code}`)

    // Envoi à API externe
    await sendCodeToApi(destNumber, `Votre code de couplage WhatsApp est : ${code}`)

    sockets.set(userId, sock)
    res.json({ success: true, pairingCode: code })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ROUTE - Envoi message texte
app.post('/send-message', async (req, res) => {
  const { userId, to, message } = req.body
  if (!userId || !to || !message) return res.status(400).json({ error: 'userId, to et message requis' })

  try {
    const sock = await getSocket(userId)
    await sock.sendMessage(to, { text: message })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ROUTE - Envoi média (image, vidéo, doc via URL ou base64)
app.post('/send-media', async (req, res) => {
  const { userId, to, media, caption } = req.body
  if (!userId || !to || !media?.url && !media?.data) return res.status(400).json({ error: 'userId, to et media.url ou media.data requis' })

  try {
    const sock = await getSocket(userId)
    const message = {}

    if (media.url) {
      if (media.type === 'image') message.image = { url: media.url }
      else if (media.type === 'video') message.video = { url: media.url }
      else if (media.type === 'audio') message.audio = { url: media.url }
      else message.document = { url: media.url }
    } else if (media.data) {
      const buffer = Buffer.from(media.data, 'base64')
      if (media.type === 'image') message.image = { buffer }
      else if (media.type === 'video') message.video = { buffer }
      else if (media.type === 'audio') message.audio = { buffer }
      else message.document = { buffer }
    }

    if (caption) message.caption = caption

    await sock.sendMessage(to, message)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ROUTE - Envoi bouton interactif
app.post('/send-buttons', async (req, res) => {
  const { userId, to, text, buttons, title = '', footer = '' } = req.body
  if (!userId || !to || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
    return res.status(400).json({ error: 'userId, to, text et buttons[] requis' })
  }

  try {
    const sock = await getSocket(userId)
    const waButtons = buttons.map(btn => typeof btn === 'string' ? { buttonId: btn, buttonText: { displayText: btn }, type: 1 } : btn)
    await sock.sendMessage(to, {
      text,
      footer,
      buttons: waButtons,
      headerType: 1,
      ...(title ? { title } : {})
    })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ROUTE - Supprimer message (messageKey)
app.delete('/delete-message', async (req, res) => {
  const { userId, remoteJid, id, fromMe = true } = req.body
  if (!userId || !remoteJid || !id) return res.status(400).json({ error: 'userId, remoteJid et id requis' })

  try {
    const sock = await getSocket(userId)
    await sock.sendMessage(remoteJid, {
      delete: {
        remoteJid,
        id,
        fromMe
      }
    })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ROUTE - Définir webhook par utilisateur
app.post('/set-webhook', (req, res) => {
  const { userId, url } = req.body
  if (!userId || !url) return res.status(400).json({ error: 'userId et url requis' })

  const webhookPath = path.join(webhookBaseDir, userId + '.json')
  fs.writeFileSync(webhookPath, JSON.stringify({ url }, null, 2))
  res.json({ success: true, message: `Webhook défini pour ${userId}` })
})

// Démarrage serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur Baileys démarré sur http://localhost:${PORT}`)
})
