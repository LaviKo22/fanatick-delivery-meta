const express = require('express')
const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const cors = require('cors')

const WA_TOKEN        = process.env.WA_TOKEN        || ''
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

async function sendMsg(to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', to: to.replace(/[^0-9]/g, ''), type: 'text', text: { body: text } },
            { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
        )
    } catch(e) { console.error('Send error:', e.response?.data || e.message) }
}

async function notifyTrader(text) { await sendMsg(TRADER_NUMBER, text) }
async function sendTemplate(to, customerName, gameName) {
    try {
        await axios.post(
            `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''),
                type: 'template',
                template: {
                    name: 'ticket_delivery',
                    language: { code: 'en' },
                    components: [{
                        type: 'body',
                        parameters: [
                            { type: 'text', parameter_name: 'customer_name', text: customerName },
                            { type: 'text', parameter_name: 'game_name', text: gameName }
                        ]
                    }]
                }
            },
            { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
        )
        await logMsg(null, 'bot', `Template sent to ${to}`)
    } catch(e) { console.error('Template error:', e.response?.data || e.message) }
}

async function downloadMedia(mediaId) {
    try {
        const { data: m } = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, { headers: { Authorization: `Bearer ${WA_TOKEN}` } })
        const { data } = await axios.get(m.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` }, responseType: 'arraybuffer' })
        return { buffer: Buffer.from(data), mimeType: m.mime_type || 'image/jpeg' }
    } catch(e) { return null }
}

async function uploadToStorage(buffer, mimeType, deliveryId) {
    try {
        const ext = mimeType.includes('png') ? 'png' : mimeType.includes('mp4') ? 'mp4' : 'jpg'
        const filename = `${deliveryId}/${Date.now()}.${ext}`
        const { error } = await supabase.storage.from('delivery-images').upload(filename, buffer, { contentType: mimeType })
        if (error) { console.error('Upload error:', error); return null }
        const { data } = supabase.storage.from('delivery-images').getPublicUrl(filename)
        return data.publicUrl
    } catch(e) { console.error('Storage error:', e); return null }
}

async function getDelivery(phone) {
    const clean = '+' + phone.replace(/[^0-9]/g, '')
    const { data } = await supabase.from('deliveries').select('*').eq('client_whatsapp', clean).not('status', 'in', '("removed")').order('created_at', { ascending: false }).limit(1)
    return data?.[0] || null
}

async function updateDelivery(id, updates) {
    await supabase.from('deliveries').update(updates).eq('id', id)
}

async function saveProof(deliveryId, proofUrl, proofType) {
    await supabase.from('delivery_proofs').insert({ delivery_id: deliveryId, proof_url: proofUrl, proof_type: proofType })
}

async function logMsg(deliveryId, sender, message, mediaUrl, mediaType) {
    if (!deliveryId) return
    try {
        await supabase.from('delivery_messages').insert({
            delivery_id: deliveryId,
            sender,
            message: message || '',
            media_url: mediaUrl || null,
            media_type: mediaType || null
        })
    } catch(e) { console.error('Log error:', e.message) }
}

async function botMsg(to, text, deliveryId) {
    await sendMsg(to, text)
    await logMsg(deliveryId, 'bot', text)
}

async function analyzeImage(buffer, prompt) {
    try {
        const b64 = buffer.toString('base64')
        const res = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }],
            max_tokens: 150
        })
        let raw = res.choices[0].message.content.trim()
        if (raw.includes('```')) raw = raw.split('```')[1].replace('json','').trim()
        return JSON.parse(raw)
    } catch(e) { return null }
}

function getIntent(msg) {
    const m = msg.toLowerCase()
    if (/iphone|apple|ios/.test(m)) return 'iphone'
    if (/android|samsung|google|pixel|huawei/.test(m)) return 'android'
    if (/yes|ok|done|got it|understood|ready|sure|yep|added/.test(m) || msg.includes('✅')) return 'confirmed'
    if (/help|can't|cant|stuck|how|not working|don't see/.test(m)) return 'confused'
    if (/wrong|incorrect|mistake|different/.test(m)) return 'wrong'
    return 'other'
}

async function startDelivery(d) {
    await sendTemplate(d.client_whatsapp, d.client_name, d.game_name)
    await updateDelivery(d.id, { status: 'phone_detected' })
    await logMsg(d.id, 'system', 'Delivery started')
    await notifyTrader(`🚀 Delivery started\nClient: ${d.client_name}\nGame: ${d.game_name}\nOrder: #${d.order_number}`)
}

async function handlePhoneDetect(d, from, msg) {
    const intent = getIntent(msg)
    if (intent === 'iphone') {
        await updateDelivery(d.id, { status: 'briefed', phone_type: 'iphone' })
        await botMsg(from, `Perfect 🍎 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Apple Wallet* immediately\n• Keep until after the game\n• Remove after full time\n\nReply ✅ when ready`, d.id)
    } else if (intent === 'android') {
        await updateDelivery(d.id, { status: 'briefed', phone_type: 'android' })
        await botMsg(from, `Perfect 🤖 Before I send your link:\n\n⚠️ *Important:*\n• Do NOT share the link\n• Add to *Google Wallet* immediately\n• Keep until after the game\n• Remove after full time\n\nReply ✅ when ready`, d.id)
    } else {
        await botMsg(from, `Are you on *iPhone* or *Android*? 📱`, d.id)
    }
}

async function handleBriefed(d, from, msg) {
    if (getIntent(msg) !== 'confirmed') { await botMsg(from, `Please reply ✅ when ready 👆`, d.id); return }
    const links = (d.links || '').split('\n').filter(l => l.trim())
    const wallet = d.phone_type === 'iphone' ? 'Apple Wallet' : 'Google Wallet'
    const linksText = links.map((l, i) => `🎫 *Ticket ${i+1}:*\n${l}`).join('\n\n')
    await botMsg(from, `Here are your ticket links:\n\n${linksText}\n\n1️⃣ Tap each link\n2️⃣ Add to *${wallet}*\n3️⃣ Send me a screenshot 📸`, d.id)
    await updateDelivery(d.id, { status: 'links_sent' })
}

async function handleLinksSent(d, from, msg, imgData) {
    if (imgData) {
        const { buffer, mimeType, publicUrl } = imgData
        const result = await analyzeImage(buffer, 'Does this show tickets in Apple or Google Wallet? JSON only: {"confirmed":true,"notes":"brief"}')
        await saveProof(d.id, publicUrl, 'wallet_screenshot')
        if (result?.confirmed) {
            await updateDelivery(d.id, { status: 'wallet_confirmed' })
            await botMsg(from, `✅ *Confirmed!* Tickets in your wallet.\n\nEnjoy *${d.game_name}*! 🏟️⚽\n\nI'll remind you to remove after full time.`, d.id)
            await notifyTrader(`✅ ${d.client_name} — wallet confirmed!\nOrder: #${d.order_number}`)
        } else {
            await botMsg(from, `Can't confirm. Make sure all tickets are visible and send another screenshot 📸`, d.id)
        }
    } else if (getIntent(msg) === 'confused') {
        await botMsg(from, d.phone_type === 'iphone'
            ? `Try:\n1. Open in *Safari*\n2. Scroll → *Add to Apple Wallet*\n3. Tap *Add*\n\nStuck? Send screenshot 📱`
            : `Try:\n1. Open in *Chrome*\n2. Scroll → *Save to Google Wallet*\n3. Tap *Save*\n\nStuck? Send screenshot 📱`, d.id)
    } else if (getIntent(msg) === 'wrong') {
        await botMsg(from, `Sorry! 🙏 Team notified — correct link coming shortly.`, d.id)
        await notifyTrader(`⚠️ WRONG LINK\nClient: ${d.client_name}\nOrder: #${d.order_number}\nReply: RESEND ${d.client_whatsapp.replace('+','')} new_link`)
    } else {
        await botMsg(from, `Once added, send me a screenshot 📸`, d.id)
    }
}

async function handleWalletConfirmed(d, from, msg, imgData) {
    if (imgData) {
        const { buffer, publicUrl } = imgData
        const result = await analyzeImage(buffer, 'Has ticket been removed from wallet? JSON only: {"removed":true,"notes":"brief"}')
        await saveProof(d.id, publicUrl, 'removal_proof')
        if (result?.removed) {
            await updateDelivery(d.id, { status: 'removed' })
            await botMsg(from, `✅ Tickets removed. Thanks, hope you enjoyed the game! 🙌`, d.id)
            await notifyTrader(`✅ ${d.client_name} — removal confirmed. Complete!`)
        } else {
            await botMsg(from, `Can't confirm. Delete from wallet and send screenshot 📱`, d.id)
        }
    } else {
        await botMsg(from, `👋 Game over — please *remove your tickets* now and send a screenshot 📸`, d.id)
    }
}

async function handleTraderCommand(msg) {
    const m = msg.trim()
    if (m.toUpperCase() === 'HELP') { await notifyTrader(`🤖 Commands:\nSTATUS\nRESEND 447xxx link\nGAMEOVER 447xxx\nREPLY 447xxx message`); return }
    if (m.toUpperCase() === 'STATUS') {
        const { data } = await supabase.from('deliveries').select('client_name,game_name,status,order_number').not('status', 'in', '("removed")')
        await notifyTrader(data?.length ? ['📊 Active:\n', ...data.map(d => `• ${d.client_name} — ${d.status}`)].join('\n') : 'No active deliveries.')
        return
    }
    if (m.toUpperCase().startsWith('RESEND ')) {
        const parts = m.split(' '), phone = '+' + parts[1].replace(/[^0-9]/g, ''), links = parts.slice(2).join('\n')
        const d = await getDelivery(phone)
        if (d) { await updateDelivery(d.id, { links, status: 'links_sent' }); await botMsg(phone, `Sorry! 🙏 Correct links:\n\n${links}\n\nAdd to wallet and send screenshot ✅`, d.id) }
        return
    }
    if (m.toUpperCase().startsWith('GAMEOVER ')) {
        const phone = '+' + m.split(' ')[1].replace(/[^0-9]/g, ''), d = await getDelivery(phone)
        if (d) { await botMsg(phone, `👋 Game over — remove tickets now and send screenshot 📸`, d.id) }
        return
    }
    if (m.toUpperCase().startsWith('REPLY ')) {
        const parts = m.split(' '), phone = '+' + parts[1].replace(/[^0-9]/g, ''), message = parts.slice(2).join(' ')
        const d = await getDelivery(phone)
        await sendMsg(phone, message)
        await logMsg(d?.id, 'trader', message)
        return
    }
}

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge'])
    else res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
    res.sendStatus(200)
    try {
        const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages
        if (!messages?.length) return
        const msg = messages[0], from = msg.from, type = msg.type
        const text = type === 'text' ? msg.text?.body : `[${type}]`
        console.log(`From ${from}: ${text}`)

        if (from === TRADER_NUMBER) { if (type === 'text') await handleTraderCommand(text); return }

        const delivery = await getDelivery(from)
        if (!delivery) { await sendMsg(from, `Hi! This is Fanatick ticket delivery 🎫`); return }

        // Handle media — download, upload to storage, log with URL
        let imgData = null
        if ((type === 'image' || type === 'video') && (msg.image?.id || msg.video?.id)) {
            const mediaId = msg.image?.id || msg.video?.id
            const downloaded = await downloadMedia(mediaId)
            if (downloaded) {
                const publicUrl = await uploadToStorage(downloaded.buffer, downloaded.mimeType, delivery.id)
                imgData = { buffer: downloaded.buffer, mimeType: downloaded.mimeType, publicUrl }
                await logMsg(delivery.id, 'client', `[${type}]`, publicUrl, type)
            }
        } else {
            await logMsg(delivery.id, 'client', text)
        }

        const s = delivery.status
        if (s === 'phone_detected')        await handlePhoneDetect(delivery, from, text)
        else if (s === 'briefed')          await handleBriefed(delivery, from, text)
        else if (s === 'links_sent')       await handleLinksSent(delivery, from, text, imgData)
        else if (s === 'wallet_confirmed') await handleWalletConfirmed(delivery, from, text, imgData)

    } catch(e) { console.error('Webhook error:', e) }
})

app.post('/start-delivery', async (req, res) => {
    const { delivery_id } = req.body
    if (!delivery_id) return res.status(400).json({ error: 'delivery_id required' })
    const { data: d } = await supabase.from('deliveries').select('*').eq('id', delivery_id).single()
    if (!d) return res.status(404).json({ error: 'Not found' })
    await startDelivery(d)
    res.json({ success: true })
})

app.post('/send-message', async (req, res) => {
    const { to, message, delivery_id } = req.body
    if (!to || !message) return res.status(400).json({ error: 'to and message required' })
    await sendMsg(to, message)
    await logMsg(delivery_id, 'trader', message)
    res.json({ success: true })
})

app.get('/messages/:deliveryId', async (req, res) => {
    const { data } = await supabase.from('delivery_messages').select('*').eq('delivery_id', req.params.deliveryId).order('created_at', { ascending: true })
    res.json(data || [])
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))
app.get('/', (req, res) => res.json({ status: 'Fanatick Delivery Agent' }))

app.listen(PORT, () => console.log(`🚀 Fanatick Delivery Agent on port ${PORT}`))
