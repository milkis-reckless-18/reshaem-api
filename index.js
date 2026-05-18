require('dotenv').config()
const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(cors({ origin: '*' }))
app.options('*', cors())
app.use(express.json({ limit: '10mb' }))

// Load system prompt from same directory as this file
const promptMd = fs.readFileSync(path.join(__dirname, 'claude_system_prompt.md'), 'utf8')
const promptMatch = promptMd.match(/```\n([\s\S]+?)\n```/)
const SYSTEM_PROMPT = promptMatch ? promptMatch[1] : ''

function preprocessForTTS(text) {
  const ordinals = { '2': 'второй', '3': 'третьей', '4': 'четвёртой' }
  return text
    .replace(/(-?)(\d+)\/\(([^)]+)\)\^(\d+)/g, (_, minus, num, expr, exp) =>
      `${minus ? 'минус ' : ''}${num} делить на ${expr} в ${ordinals[exp] ?? exp} степени`)
    .replace(/f'\(x\)/g, 'эф штрих от икс')
    .replace(/f\(g\(x\)\)/g, 'эф от джи от икс')
    .replace(/f\(x\)/g, 'эф от икс')
    .replace(/g\(x\)/g, 'джи от икс')
    .replace(/1\/2/g, 'одна вторая')
    .replace(/1\/4/g, 'одна четвёртая')
    .replace(/1\/3/g, 'одна третья')
    .replace(/3\/2/g, 'три вторых')
    .replace(/2\/4/g, 'две четвёртых')
    .replace(/x\^(\d+)/g, (_, n) => `икс во ${ordinals[n] ?? n} степени`)
    .replace(/x\^\(([^)]+)\)/g, (_, c) => `икс в степени ${c}`)
    .replace(/cos\s*([A-Za-z])\s*·\s*cos\s*([A-Za-z])/g, (_, a, b) => `косинус ${a} умножить на косинус ${b}`)
    .replace(/sin\s*([A-Za-z])\s*·\s*sin\s*([A-Za-z])/g, (_, a, b) => `синус ${a} умножить на синус ${b}`)
    .replace(/cos\(([^-+)]+)\s*\+\s*([^)]+)\)/g, (_, a, b) => `косинус суммы ${a.trim()} и ${b.trim()}`)
    .replace(/cos\(([^-+)]+)\s*-\s*([^)]+)\)/g, (_, a, b) => `косинус разности ${a.trim()} и ${b.trim()}`)
    .replace(/cos\s+([A-Za-z])\b/g, (_, a) => `косинус ${a}`)
    .replace(/cos([A-Za-z])\b/g, (_, a) => `косинус ${a}`)
    .replace(/sin\s+([A-Za-z])\b/g, (_, a) => `синус ${a}`)
    .replace(/sin([A-Za-z])\b/g, (_, a) => `синус ${a}`)
    .replace(/tan\s+([A-Za-z])\b/g, (_, a) => `тангенс ${a}`)
    .replace(/tan([A-Za-z])\b/g, (_, a) => `тангенс ${a}`)
    .replace(/cos\(/g, 'косинус от ')
    .replace(/sin\(/g, 'синус от ')
    .replace(/tan\(/g, 'тангенс от ')
    .replace(/ln\(/g, 'натуральный логарифм от ')
    .replace(/log\(/g, 'логарифм от ')
    .replace(/sqrt\(/g, 'корень из ')
    .replace(/·/g, ' умножить на ')
    .replace(/=>/g, 'следовательно')
    .replace(/>=/g, 'больше или равно')
    .replace(/<=/g, 'меньше или равно')
}

// ── POST /ocr ────────────────────────────────────────────────────────────────

app.post('/ocr', async (req, res) => {
  const { image } = req.body
  if (!image) {
    return res.json({ error: 'Missing image', confidence_flag: 'ocr_uncertain' })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const mathpixRes = await fetch('https://api.mathpix.com/v3/text', {
      method: 'POST',
      headers: {
        'app_id': process.env.MATHPIX_APP_ID ?? '',
        'app_key': process.env.MATHPIX_APP_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        src: `data:image/jpeg;base64,${image}`,
        formats: ['latex_styled', 'text'],
        data_options: { include_svg: false },
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!mathpixRes.ok) {
      console.error('Mathpix error', mathpixRes.status, await mathpixRes.text())
      return res.json({ error: 'OCR failed', confidence_flag: 'ocr_uncertain' })
    }

    const data = await mathpixRes.json()
    if (data.error) {
      console.error('Mathpix returned error:', data.error)
      return res.json({ error: data.error, confidence_flag: 'ocr_uncertain' })
    }

    const latex = data.latex_styled || data.text || ''
    const confidence_flag = latex.trim().length === 0 ? 'ocr_uncertain' : 'ok'
    res.json({ latex, confidence_flag })
  } catch (err) {
    console.error('/ocr error:', err.message)
    res.status(500).json({ error: err.message, confidence_flag: 'ocr_uncertain' })
  }
})

// ── POST /explain ────────────────────────────────────────────────────────────

app.post('/explain', async (req, res) => {
  const { latex, confidence_flag, rephrase } = req.body

  try {
    // Rephrase mode: reword a single step explanation in simpler terms
    if (rephrase) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `перефразируй этот шаг проще, другими словами, без новой информации. Верни только новый текст объяснения, без JSON.\n\n${rephrase}`,
          }],
        }),
      })
      if (!r.ok) {
        const errText = await r.text()
        return res.status(500).json({ error: `Anthropic error ${r.status}: ${errText}` })
      }
      const d = await r.json()
      const rephrased = d.content?.[0]?.text ?? rephrase
      return res.json({ rephrased })
    }

    // Main explain mode
    const systemPrompt = confidence_flag === 'ocr_uncertain'
      ? SYSTEM_PROMPT + '\n\nOCR может быть неточным. Делай всё возможное с имеющимися данными. НИКОГДА не упоминай OCR, распознавание текста или системные ошибки ученику. Если что-то неясно — спроси ученика уточнить конкретный шаг, не объясняя причину.'
      : SYSTEM_PROMPT

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `LaTeX распознанного решения:\n\n${latex}` },
        ],
      }),
    })

    if (!r.ok) {
      const errText = await r.text()
      return res.status(500).json({ error: `Anthropic error ${r.status}: ${errText}` })
    }

    const d = await r.json()
    const rawText = d.content?.[0]?.text ?? ''
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return res.status(500).json({ error: 'No JSON in Claude response' })

    const parsed = JSON.parse(jsonMatch[0])
    res.json(parsed)
  } catch (err) {
    console.error('/explain error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /speak ──────────────────────────────────────────────────────────────

app.post('/speak', async (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'Missing text' })

  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: preprocessForTTS(text),
        voice: 'echo',
      }),
    })

    if (!r.ok) {
      const errText = await r.text()
      return res.status(500).json({ error: `OpenAI TTS error ${r.status}: ${errText}` })
    }

    const buffer = Buffer.from(await r.arrayBuffer())
    res.set('Content-Type', 'audio/mpeg')
    res.send(buffer)
  } catch (err) {
    console.error('/speak error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }))

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Reshaem server running on port ${PORT}`))
