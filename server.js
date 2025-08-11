// Installation : npm install express baileys qrcode
import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from 'baileys'
import qrcode from 'qrcode'

const app = express()
app.use(express.json())

let sock
let authenticated = false
let lastQR = null

// Fonction d'initialisation de la connexion WhatsApp
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    })

    // Événements connexion / QR code
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            lastQR = await qrcode.toDataURL(qr) // Convertir le QR en base64
            console.log('📱 QR code généré pour authentification')
        }

        if (connection === 'open') {
            console.log('✅ Bot WhatsApp connecté')
            authenticated = true
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            authenticated = false
            console.log(`⚠️ Connexion fermée (code: ${reason}), reconnexion...`)
            if (reason !== DisconnectReason.loggedOut) {
                startSock()
            }
        }
    })

    // Sauvegarde de l'état d'authentification
    sock.ev.on('creds.update', saveCreds)
}

// Démarrage initial
startSock()

// 📌 ROUTE : Authentification → retourne QR en base64
app.get('/auth', (req, res) => {
    if (authenticated) {
        return res.json({ status: 'already_authenticated' })
    }
    if (!lastQR) {
        return res.json({ status: 'waiting_for_qr' })
    }
    res.json({ qr: lastQR })
})

// 📌 ROUTE : Statut → authentifié ou non
app.get('/status', (req, res) => {
    res.json({ authenticated })
})

// 📌 ROUTE : Envoi message
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
        res.status(500).json({ error: 'Erreur lors de l\'envoi du message' })
    }
})

// Lancer le serveur
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`)
})
