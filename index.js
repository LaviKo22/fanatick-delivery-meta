const express = require('express')
const cors = require('cors')
const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')

// ============================================================
//  CONFIG
// ============================================================

const WA_TOKEN        = process.env.WA_TOKEN        || 'EAALQkef2WmkBRH2n2X1ZCf1Pw5uAH4zyjQ1oVZB57EelxQGDaNrnllspP0v0QuYI90gzjIW5mcZArqc9WXvzVOayEN4Bjn8ZASZAGFiHaqSnSEHf8omo0fZBUnt7YihipsHlpOS4sjXHTd5PyGE2zqxUo8usPEz5wwWEvsQmVKxcqAN3d0ITH33tQknhh3v3N3kBRZBD0E0TejW5ZAO1xLxWGAzJ24JH73K43oO5yw8MNSRvDnrs8Fps9bbXZBFAqpfYZAkAyS9CGSVboeKEIStV2zlNsQ'
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '899217986619417'
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'fanatick123'
const TRADER_NUMBER   = process.env.TRADER_NUMBER   || '447451295914'
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://igrlhrtjcmippqilqgyx.supabase.co'
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY  || ''
const PORT            = process.env.PORT            || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY })
const app      = express()
app.use(express.json())
app.use(cors())

// ============================================================
//  WHATSAPP HELPERS
// ============================================================

async function sendMsg(to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''),
                type: 'text',
                text: { body: text }
            },
            { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
        )
    } catch(e) {
        console.error('Send error:', e.response?.data || e.message)
    }
}

async function notifyTrader(text) {
    await sendMsg(TRADER_NUMBER, text)
}

async function downloadMedia(mediaId) {
    try {
        const { data: mediaData } = await axios.get(
            `https://graph.facebook.com/v22.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
        )
        const { data } = await axios.get(mediaData.url, {
            headers: { Authorization: `Bearer ${WA_TOKEN}` },
            responseType: 'arraybuffer'
        })
        return Buffer.from(data)
    } catch(e) {
        console.error('Media download error:', e.message)
        return null
    }
}

// ============================================================
//  SUPABASE HELPERS
// ============================================================

async function getDelivery(phone) {
    const clean = '+' + phone.replace(/[^0-9]/g, '')
    const { data } = await supabase
        .from('deliveries')
        .select('*')
        .eq('client_whatsapp', clean)
        .not('status', 'in', '("removed")')
        .order('created_at', { ascending: false })
        .limit(1)
    return data?.[0] || null
}

async function updateDelivery(id, updates) {
    await supabase.from('deliveries').update(updates).eq('id', id)
}

async function saveProof(deliveryId, proofType) {
    await supabase.from('delivery_proofs').insert({
        delivery_id: deliveryId,
        proof_url: proofType,
        proof_type: proofType
    })
}

// ============================================================
//  GPT HELPERS
// ============================================================

async function analyzeImage(buffer, prompt) {
    try {
        const b64 = buffer.toString('base64')
        const res = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
            ]}],
            max_tokens: 150
        })
        let raw = res.choices[0].message.content.trim()
        if (raw.includes('```')) raw = raw.split('```')[1].replace('json','').trim()
        return JSON.parse(raw)
    } catch(e) { return null }
}

function getIntent(msg) {
    const m = msg.toLowerCase()
    if (/iphone|apple|ios/.test(m))                                        return 'iphone'
    if (/android|samsung|google|pixel|huawei/.test(m))                     return 'android'
    if (/yes|ok|done|got it|understood|ready|sure|yep|added/.test(m) || msg.includes('✅')) return 'confirmed'
    if (/help|can't|cant|stuck|how|not working|don't see/.test(m))         return 'confused'
    if (/wrong|incorrect|mistake|different/.test(m))                       return 'wrong'
    return 'other'
}

// ============================================================
//  DELIVERY FLOW
// ============================================================

async function startDelivery(delivery) {
    await sendMsg(delivery.client_whatsapp,
        `👋 Hi ${delivery.client_name}! I'm the Fanatick delivery assistant for *${delivery.game_name}*.\n\nAre you on *iPhone* or *Android*? 📱`
    )
    await updateDelivery(delivery.id, { status: 'phone_detected' })
    await notifyTrader(`🚀 Delivery started\nClient: ${delivery.client_name}\nGame: ${delivery.game_name}\nOrder: #${delivery.order_number}`)
}

async function handlePhoneDetect(d, from, msg) {
    const intent = getIntent(msg)
    if (intent === 'iphone') {
        await updateDelivery(d.id, { status: 'briefed', phone_type: 'iphone' })
        await sendMsg(from, `Perfect 🍎 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Apple Wallet* immediately\n• Keep until after the game\n• Remove after full time\n\nReply ✅ when ready`)
        await notifyTrader(`📱 ${d.client_name} — iPhone detected`)
    } else if (intent === 'android') {
        await updateDelivery(d.id, { status: 'briefed', phone_type: 'android' })
        await sendMsg(from, `Perfect 🤖 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Google Wallet* immediately\n• Keep until after the game\n• Remove after full time\n\nReply ✅ when ready`)
        await notifyTrader(`📱 ${d.client_name} — Android detected`)
    } else {
        await sendMsg(from, `Are you on *iPhone* or *Android*? 📱`)
    }
}

async function handleBriefed(d, from, msg) {
    if (getIntent(msg) !== 'confirmed') {
        await sendMsg(from, `Please reply ✅ when you've read the instructions 👆`)
        return
    }
    const links = (d.links || '').split('\n').filter(l => l.trim())
    const wallet = d.phone_type === 'iphone' ? 'Apple Wallet' : 'Google Wallet'
    const linksText = links.map((l, i) => `🎫 *Ticket ${i+1}:*\n${l}`).join('\n\n')
    await sendMsg(from, `Here are your ticket links:\n\n${linksText}\n\n1️⃣ Tap each link\n2️⃣ Add to *${wallet}*\n3️⃣ Send me a screenshot 📸`)
    await updateDelivery(d.id, { status: 'links_sent' })
    await notifyTrader(`🔗 ${d.client_name} — links sent`)
}

async function handleLinksSent(d, from, msg, imgBuffer) {
    if (imgBuffer) {
        const result = await analyzeImage(imgBuffer, 'Does this show tickets in Apple or Google Wallet? JSON only: {"confirmed":true,"notes":"brief"}')
        await saveProof(d.id, 'wallet_screenshot')
        if (result?.confirmed) {
            await updateDelivery(d.id, { status: 'wallet_confirmed' })
            await sendMsg(from, `✅ *Confirmed!* Tickets are in your wallet.\n\nEnjoy *${d.game_name}*! 🏟️⚽\n\nI'll remind you to remove after full time.`)
            await notifyTrader(`✅ ${d.client_name} — wallet confirmed!\nOrder: #${d.order_number}`)
        } else {
            await sendMsg(from, `Hmm, can't confirm the tickets. Make sure all are visible and send another screenshot 📸`)
            await notifyTrader(`⚠️ ${d.client_name} — wallet screenshot unclear`)
        }
    } else if (getIntent(msg) === 'confused') {
        await sendMsg(from, d.phone_type === 'iphone'
            ? `Try:\n1. Open in *Safari*\n2. Scroll → *Add to Apple Wallet*\n3. Tap *Add*\n\nStuck? Send screenshot 📱`
            : `Try:\n1. Open in *Chrome*\n2. Scroll → *Save to Google Wallet*\n3. Tap *Save*\n\nStuck? Send screenshot 📱`)
        await notifyTrader(`❓ ${d.client_name} is confused — bot helping`)
    } else if (getIntent(msg) === 'wrong') {
        await sendMsg(from, `Sorry! 🙏 The team has been notified — correct link coming shortly.`)
        await notifyTrader(`⚠️ WRONG LINK — ${d.client_name}\nOrder: #${d.order_number}\nNumber: ${d.client_whatsapp}\n\nReply: RESEND ${d.client_whatsapp.replace('+','')} new_link1 new_link2`)
    } else {
        await sendMsg(from, `Once added, send me a screenshot 📸`)
    }
}

async function handleWalletConfirmed(d, from, msg, imgBuffer) {
    if (imgBuffer) {
        const result = await analyzeImage(imgBuffer, 'Has this ticket been removed from Apple/Google Wallet? JSON only: {"removed":true,"notes":"brief"}')
        await saveProof(d.id, 'removal_proof')
        if (result?.removed) {
            await updateDelivery(d.id, { status: 'removed' })
            await sendMsg(from, `✅ Tickets removed. Thanks, hope you enjoyed the game! 🙌`)
            await notifyTrader(`✅ ${d.client_name} — removal confirmed. Delivery complete!`)
        } else {
            await sendMsg(from, `Can't confirm removal. Please delete from wallet and send a screenshot 📱`)
        }
    } else {
        await sendMsg(from, `👋 Game over — please *remove your tickets* now and send a screenshot 📸`)
    }
}

async function handleTraderCommand(msg) {
    const m = msg.trim()

    if (m.toUpperCase() === 'HELP') {
        await notifyTrader(`🤖 *Commands:*\nSTATUS — active deliveries\nRESEND 447xxx link1 link2 — fix wrong links\nGAMEOVER 447xxx — trigger removal chase\nREPLY 447xxx your message — send message to client`)
        return
    }

    if (m.toUpperCase() === 'STATUS') {
        const { data } = await supabase.from('deliveries').select('client_name,game_name,status,order_number').not('status', 'in', '("removed")')
        if (!data?.length) { await notifyTrader('No active deliveries.'); return }
        const lines = ['📊 *Active:*\n']
        for (const d of data) lines.push(`• ${d.client_name} — ${d.game_name}\n  ${d.status} | #${d.order_number}`)
        await notifyTrader(lines.join('\n'))
        return
    }

    if (m.toUpperCase().startsWith('RESEND ')) {
        const parts = m.split(' ')
        const phone = '+' + parts[1].replace(/[^0-9]/g, '')
        const links = parts.slice(2).join('\n')
        const d = await getDelivery(phone)
        if (d) {
            await updateDelivery(d.id, { links, status: 'links_sent' })
            const linkList = links.split('\n').filter(l => l.trim())
            const linksText = linkList.map((l, i) => `🎫 *Ticket ${i+1}:*\n${l}`).join('\n\n')
            await sendMsg(phone, `Sorry for the mix-up! 🙏 Here are your correct links:\n\n${linksText}\n\nPlease add to your wallet and send a screenshot ✅`)
            await notifyTrader(`✅ Correct links sent to ${d.client_name}`)
        } else {
            await notifyTrader(`No active delivery for ${phone}`)
        }
        return
    }

    if (m.toUpperCase().startsWith('GAMEOVER ')) {
        const phone = '+' + m.split(' ')[1].replace(/[^0-9]/g, '')
        const d = await getDelivery(phone)
        if (d) {
            await sendMsg(phone, `👋 Game over — please *remove your tickets* now and send a screenshot 📸`)
            await notifyTrader(`✅ Removal chase sent to ${d.client_name}`)
        } else {
            await notifyTrader(`No active delivery for ${phone}`)
        }
        return
    }

    if (m.toUpperCase().startsWith('REPLY ')) {
        const parts = m.split(' ')
        const phone = '+' + parts[1].replace(/[^0-9]/g, '')
        const message = parts.slice(2).join(' ')
        await sendMsg(phone, message)
        await notifyTrader(`✅ Message sent to ${phone}`)
        return
    }
}

// ============================================================
//  WEBHOOK
// ============================================================

app.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode']
    const token     = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Webhook verified')
        res.status(200).send(challenge)
    } else {
        res.sendStatus(403)
    }
})

app.post('/webhook', async (req, res) => {
    res.sendStatus(200)
    try {
        const entry    = req.body?.entry?.[0]
        const changes  = entry?.changes?.[0]
        const value    = changes?.value
        const messages = value?.messages
        if (!messages?.length) return

        const msg  = messages[0]
        const from = msg.from
        const type = msg.type

        console.log(`Message from ${from}: type=${type}`)

        // Trader commands
        if (from === TRADER_NUMBER) {
            if (type === 'text') await handleTraderCommand(msg.text.body)
            return
        }

        // Forward message to trader for supervision
        const text = type === 'text' ? msg.text?.body : `[${type} received]`

        // Get delivery
        const delivery = await getDelivery(from)
        if (!delivery) {
            await sendMsg(from, `Hi! This is Fanatick ticket delivery. Your delivery will begin shortly 🎫`)
            return
        }

        // Forward to trader
        await notifyTrader(`💬 ${delivery.client_name} (${delivery.game_name}):\n"${text}"`)

        // Download image if present
        let imgBuffer = null
        if (type === 'image') {
            const mediaId = msg.image?.id
            if (mediaId) imgBuffer = await downloadMedia(mediaId)
        }

        // Handle by stage
        const status = delivery.status
        if (status === 'phone_detected')      await handlePhoneDetect(delivery, from, text)
        else if (status === 'briefed')        await handleBriefed(delivery, from, text)
        else if (status === 'links_sent')     await handleLinksSent(delivery, from, text, imgBuffer)
        else if (status === 'wallet_confirmed') await handleWalletConfirmed(delivery, from, text, imgBuffer)
        else if (status === 'removed')        await sendMsg(from, `Your delivery is complete! Thanks 🙏`)

    } catch(e) {
        console.error('Webhook error:', e)
    }
})

// ============================================================
//  START DELIVERY ENDPOINT (called by dashboard)
// ============================================================

app.post('/start-delivery', async (req, res) => {
    const { delivery_id } = req.body
    if (!delivery_id) return res.status(400).json({ error: 'delivery_id required' })
    const { data: d } = await supabase.from('deliveries').select('*').eq('id', delivery_id).single()
    if (!d) return res.status(404).json({ error: 'Not found' })
    await startDelivery(d)
    res.json({ success: true })
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))
app.get('/', (req, res) => res.json({ status: 'Fanatick Delivery Agent running' }))

app.listen(PORT, () => console.log(`🚀 Fanatick Delivery Agent on port ${PORT}`))

// Send message endpoint for dashboard chat
app.post('/send-message', async (req, res) => {
    const { to, message } = req.body
    if (!to || !message) return res.status(400).json({ error: 'to and message required' })
    try {
        await sendMsg(to, message)
        res.json({ success: true })
    } catch(e) {
        res.status(500).json({ error: e.message })
    }
})
