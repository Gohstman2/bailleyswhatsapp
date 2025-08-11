import express from 'express'
import axios from 'axios'
import { makeWASocket, useMultiFileAuthState } from 'baileys'
import path from 'path'
import fs from 'fs'

const app = express()
app.use(express.json())

const clients = {}

// Démarre et retourne un sock Baileys pour un client
async function startClient(clientId, number) {
  const authPath = path.join('./sessions', clientId)
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authPath)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  })

  clients[clientId] = {
    sock,
    number,
    pairingCode: null,
    authenticated: false,
    saveCreds,
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'open') {
      clients[clientId].authenticated = true
      clients[clientId].pairingCode = null
      console.log(`Client ${clientId} connecté`)
    } else if (connection === 'close') {
      clients[clientId].authenticated = false
      console.log(`Client ${clientId} déconnecté`)
      // gérer reconnexion automatique si tu veux ici
    }
  })

  return sock
}

// Route pour générer pairing code et l’envoyer via API Python (send_whatsapp_message)
app.post('/authcode', async (req, res) => {
  const { clientId, number, whatsappDestNumber } = req.body
  if (!clientId || !number || !whatsappDestNumber) {
    return res.status(400).json({ error: 'clientId, number et whatsappDestNumber requis' })
  }

  try {
    let client = clients[clientId]

    if (!client) {
      const sock = await startClient(clientId, number)
      client = clients[clientId]
      client.sock = sock
    }

    if (client.authenticated) {
      return res.status(400).json({ error: 'Client déjà authentifié' })
    }

    // Générer le pairing code
    const pairingCode = await client.sock.requestPairingCode(number)
    client.pairingCode = pairingCode
    console.log(`Pairing code pour client ${clientId}: ${pairingCode}`)

    // Appeler l’API Python pour envoyer ce code via WhatsApp
    // Ex: POST http://localhost:5000/send-message { number: whatsappDestNumber, message: pairingCode }
    const API_PYTHON_URL = 'https://senhatsappv3.onrender.com/sendMessage'

    const message = `Votre code de couplage WhatsApp est : ${pairingCode}`

    const response = await axios.post(API_PYTHON_URL, {
      number: whatsappDestNumber,
      message
    }, { timeout: 15000 })

    if (response.data.success) {
      res.json({ success: true, pairingCode })
    } else {
      res.status(500).json({ error: 'Échec envoi message via API Python', details: response.data })
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`)
})
