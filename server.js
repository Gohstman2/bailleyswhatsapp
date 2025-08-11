import express from 'express'
import { makeWASocket, useSingleFileAuthState, DisconnectReason } from 'baileys'
import fs from 'fs'

const app = express()
app.use(express.json())

const SESSION_FILE = './auth_info.json'

// Utilisation d’une session unique stockée dans un fichier
const { state, saveState } = useSingleFileAuthState(SESSION_FILE)

let sock = null

async function startSock() {
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  })

  sock.ev.on('connection.update', (update) => {
    console.log('Connection update:', update)
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const reason = (lastDisconnect.error)?.output?.statusCode
      console.log('Connexion fermée, raison:', reason)

      // Si pas déconnecté volontairement, reconnecte
      if (reason !== DisconnectReason.loggedOut) {
        console.log('Tentative de reconnexion...')
        startSock()
      } else {
        console.log('Déconnecté volontairement, pas de reconnexion.')
      }
    } else if (connection === 'open') {
      console.log('Connecté avec succès !')
    }
  })

  sock.ev.on('creds.update', saveState)
}

await startSock()

// Route pour générer pairing code et le renvoyer dans la réponse
app.post('/authcode', async (req, res) => {
  try {
    if (!sock) return res.status(500).json({ error: 'Socket non initialisé' })

    const { number } = req.body
    if (!number) return res.status(400).json({ error: 'number requis' })

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
