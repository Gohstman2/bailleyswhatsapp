import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from 'baileys'
import qrcode from 'qrcode'

const app = express()
app.use(express.json())

let sock
let authenticated = false
let lastQR = null
let pendingPairCode = null
let pairPhone = null

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  sock = makeWASocket({ auth: state, printQRInTerminal: false })

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      lastQR = await qrcode.toDataURL(qr)
      console.log('QR généré')
    }

    // Si on attend un pairing code et que la connexion commence
    if ((connection === 'connecting' || qr) && pairPhone && !pendingPairCode) {
      const code = await sock.requestPairingCode(pairPhone)
      pendingPairCode = code
      console.log('Pairing code généré pour', pairPhone)
    }

    if (connection === 'open') {
      authenticated = true
      pendingPairCode = null
      pairPhone = null
      console.log('Bot connecté via pairing ou QR !')
    } else if (connection === 'close') {
      authenticated = false
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) startSock()
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

startSock()

// Route QR classique
app.get('/auth', (req, res) => {
  if (authenticated) return res.json({ status: 'already_authenticated' })
  if (!lastQR) return res.json({ status: 'waiting_for_qr' })
  res.json({ qr: lastQR })
})

// Route pairing via numéro
app.post('/authcode', (req, res) => {
  const { number } = req.body
  if (!number) return res.status(400).json({ error: 'number required' })

  pairPhone = number
  pendingPairCode = null
  res.json({ status: 'requesting_code' })
})

app.get('/authcode/status', (req, res) => {
  if (!pairPhone) return res.json({ status: 'no_request' })
  if (pendingPairCode) {
    return res.json({ status: 'code_ready', code: pendingPairCode })
  }
  res.json({ status: 'waiting_code' })
})

// Route status
app.get('/status', (req, res) => {
  res.json({ authenticated })
}) 

// Envoi de message
app.post('/message', async (req, res) => {
  const { number, text } = req.body
  if (!authenticated) return res.status(401).json({ error: 'Bot non authentifié' })
  try {
    const jid = number + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erreur envoi message' })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Serveur lancé sur port ${PORT}`))
