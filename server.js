import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from 'baileys'
import path from 'path'

const app = express()
app.use(express.json())

const authFolder = './auth_info'

let sock = null

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder)

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    console.log('Connection update:', connection)

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      console.log('Connexion fermée, raison:', statusCode)

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Tentative de reconnexion...')
        startSock()
      } else {
        console.log('Déconnecté volontairement, pas de reconnexion.')
      }
    } else if (connection === 'open') {
      console.log('Connecté avec succès !')
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

await startSock()

// Route POST /authcode pour générer le pairing code
app.post('/authcode', async (req, res) => {
  try {
    if (!sock) return res.status(500).json({ error: 'Socket non initialisé' })

    const { number } = req.body
    if (!number) return res.status(400).json({ error: 'number requis' })

    // Vérifie si déjà connecté
    if (sock.authState?.creds?.me) {
      return res.status(400).json({ error: 'Déjà authentifié' })
    }

    const pairingCode = await sock.requestPairingCode(number)
    console.log('Pairing code généré:', pairingCode)

    res.json({ pairingCode })
  } catch (error) {
    console.error('Erreur génération pairing code:', error)
    res.status(500).json({ error: error.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`)
})
