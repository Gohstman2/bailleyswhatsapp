// Installations nécessaires :
// npm install express baileys qrcode

import express from 'express'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys'
import qrcode from 'qrcode'

const app = express()
app.use(express.json())

let sock
let authenticated = false

// Initialisation de Baileys
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            // Stocker le QR code pour /auth
            lastQR = await qrcode.toDataURL(qr)
        }

        if (connection === 'open') {
            console.log('✅ Authentifié avec succès')
            authenticated = true
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            authenticated = false
            if (shouldReconnect) {
                startSock()
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

let lastQR = null
startSock()

// Route /auth → Retourne le QR en Base64
app.get('/auth', (req, res) => {
    if (authenticated) {
        return res.json({ status: 'already_authenticated' })
    }
    if (!lastQR) {
        return res.json({ status: 'waiting_for_qr' })
    }
    res.json({ qr: lastQR })
})

// Route /status → Renvoie l'état
app.get('/status', (req, res) => {
    res.json({ authenticated })
})

// Route /message → Envoi un message
app.post('/message', async (req, res) => {
    const { number, text } = req.body
    if (!authenticated) {
        return res.status(401).json({ error: 'Bot non authentifié' })
    }
    try {
        const jid = number + '@s.whatsapp.net'
        await sock.sendMessage(jid, { text })
        res.json({ success: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Erreur envoi message' })
    }
})

app.listen(3000, () => {
    console.log('🚀 Serveur démarré sur http://localhost:3000')
})
