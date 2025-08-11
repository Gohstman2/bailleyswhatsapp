import express from 'express'
import axios from 'axios'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from 'baileys'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(express.json())

// Stockage des clients : { idClient: { sock, authenticated, webhook, number } }
const clients = {}

// 📌 Fonction pour initialiser un client
async function initClient(idClient, number) {
    const authPath = path.join('./sessions', idClient)
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    const sock = makeWASocket({ auth: state, printQRInTerminal: false })

    clients[idClient] = { sock, authenticated: false, webhook: null, number }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        // Génération pairing code au moment de la connexion
        if (connection === 'connecting' && number) {
            try {
                const code = await sock.requestPairingCode(number)
                clients[idClient].pairingCode = code
                console.log(`📱 Pairing code pour ${idClient}: ${code}`)
            } catch (err) {
                console.error(`Erreur génération code:`, err)
            }
        }

        if (connection === 'open') {
            console.log(`✅ Client ${idClient} connecté`)
            clients[idClient].authenticated = true
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            clients[idClient].authenticated = false
            if (reason !== DisconnectReason.loggedOut) {
                initClient(idClient, number)
            }
        }
    })

    // Sauvegarde des creds
    sock.ev.on('creds.update', saveCreds)

    // Gestion des messages entrants
    sock.ev.on('messages.upsert', async (m) => {
        const webhook = clients[idClient].webhook
        if (!webhook) return
        try {
            await axios.post(webhook, { clientId: idClient, data: m })
        } catch (err) {
            console.error(`Erreur envoi webhook client ${idClient}:`, err.message)
        }
    })
}

// 📌 Route : AuthCode
app.post('/authcode', async (req, res) => {
    const { id, number } = req.body
    if (!id || !number) return res.status(400).json({ error: 'id et number requis' })

    await initClient(id, number)
    res.json({ status: 'client_initialised', id })
})

// 📌 Route : AuthStatus
app.get('/authstatus/:id', (req, res) => {
    const id = req.params.id
    if (!clients[id]) return res.status(404).json({ error: 'client inexistant' })
    res.json({ authenticated: clients[id].authenticated, pairingCode: clients[id].pairingCode || null })
})

// 📌 Route : Send message
app.post('/send/message', async (req, res) => {
    const { id, to, text } = req.body
    if (!id || !to || !text) return res.status(400).json({ error: 'id, to et text requis' })
    const client = clients[id]
    if (!client || !client.authenticated) return res.status(401).json({ error: 'client non authentifié' })

    try {
        await client.sock.sendMessage(to + '@s.whatsapp.net', { text })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// 📌 Route : Send button
app.post('/send/button', async (req, res) => {
    const { id, to, text, buttons } = req.body
    if (!id || !to || !text || !buttons) return res.status(400).json({ error: 'id, to, text, buttons requis' })
    const client = clients[id]
    if (!client || !client.authenticated) return res.status(401).json({ error: 'client non authentifié' })

    try {
        await client.sock.sendMessage(to + '@s.whatsapp.net', {
            text,
            buttons: buttons.map((b, idx) => ({ buttonId: `btn_${idx}`, buttonText: { displayText: b }, type: 1 })),
            headerType: 1
        })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// 📌 Route : Send media
app.post('/send/media', async (req, res) => {
    const { id, to, mediaPath, mimetype } = req.body
    if (!id || !to || !mediaPath || !mimetype) return res.status(400).json({ error: 'id, to, mediaPath, mimetype requis' })
    const client = clients[id]
    if (!client || !client.authenticated) return res.status(401).json({ error: 'client non authentifié' })

    try {
        const mediaBuffer = fs.readFileSync(mediaPath)
        await client.sock.sendMessage(to + '@s.whatsapp.net', { document: mediaBuffer, mimetype })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// 📌 Route : Set webhook
app.post('/setwebhook', (req, res) => {
    const { id, webhook } = req.body
    if (!id || !webhook) return res.status(400).json({ error: 'id et webhook requis' })
    const client = clients[id]
    if (!client) return res.status(404).json({ error: 'client inexistant' })

    client.webhook = webhook
    res.json({ success: true, webhook })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`🚀 Serveur multi-clients WhatsApp démarré sur port ${PORT}`)
})
