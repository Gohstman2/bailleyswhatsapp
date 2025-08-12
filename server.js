import express from 'express'
import axios from 'axios'
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys'

const app = express()
app.use(express.json())

app.post('/create-pairing', async (req, res) => {
  const { number, whatsappDestNumber } = req.body

  if (!number || !whatsappDestNumber) {
    return res.status(400).json({ error: 'number et whatsappDestNumber sont requis' })
  }

  try {
    // Initialiser l'auth pour ce numéro
    const { state, saveCreds } = await useMultiFileAuthState(`auth-${number}`)
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['MyApp', 'Chrome', '1.0.0']
    })

    sock.ev.on('creds.update', saveCreds)

    let pairingCode = null

    // Générer le pairing code si non enregistré
    if (!sock.authState.creds.registered) {
      pairingCode = await sock.requestPairingCode(number)
      console.log(`Pairing code généré : ${pairingCode}`)

      // Envoyer via API Python
      const API_PYTHON_URL = 'https://senhatsappv3.onrender.com/sendMessage'
      const message = `Votre code de couplage WhatsApp est : ${pairingCode}`

      const response = await axios.post(API_PYTHON_URL, {
        number: whatsappDestNumber,
        message
      }, { timeout: 15000 })

      if (!response.data.success) {
        return res.status(500).json({
          error: 'Échec envoi message via API Python',
          details: response.data
        })
      }
    }

    return res.json({ success: true, pairingCode })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message })
  }
})

app.listen(5000, () => {
  console.log('Serveur démarré sur http://localhost:5000')
})
