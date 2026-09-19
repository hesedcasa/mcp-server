import {createCanvas} from '@napi-rs/canvas'
import {test, type TestInfo} from '@playwright/test'
import {Buffer} from 'node:buffer'

/**
 * One captured result: a single MCP / JSON-RPC / HTTP exchange. Each capture
 * is rendered to a PNG screenshot and attached to the running test, so every
 * result is viewable in the Playwright HTML report.
 */
export type McpExchange = {
  /** Extra free-form line (e.g. a protocol error message) rendered above the response. */
  detail?: string
  durationMs?: number
  /** Request payload (serialized pretty into the screenshot). */
  request?: unknown
  /** Response payload (serialized pretty into the screenshot). */
  response?: unknown
  /** Short status label, e.g. "OK", "isError", "error -32601", "401 Unauthorized". */
  status?: string
  /** Screenshot headline, e.g. "tools/call run_command". */
  title: string
  /** Color of the status label; defaults from `tone`. */
  tone?: 'error' | 'ok' | 'warn'
  transport: 'cli' | 'http' | 'jsonrpc-raw' | 'stdio'
}

// Exchanges recorded outside a running test (beforeAll hooks, worker fixture
// setup) are queued here and flushed into the next test that captures.
const pending: McpExchange[] = []

// Attachment sequence per test — `info.attachments` is not guaranteed to have
// been updated synchronously by a previous (floating) attach call.
let lastInfo: TestInfo | undefined
let lastSeq = 0

const WIDTH = 1080
const PADDING = 28
const BODY_LINE_HEIGHT = 19
const MAX_JSON_CHARS = 5000
const MONO_FAMILY = process.platform === 'darwin' ? 'Menlo' : 'DejaVu Sans Mono'

const TONE_COLORS = {error: '#f85149', ok: '#3fb950', warn: '#d29922'} as const

/** Renders the exchange and attaches the screenshot to the running test. */
export function captureExchange(exchange: McpExchange): void {
  let info: TestInfo
  try {
    info = test.info()
  } catch {
    pending.push(exchange)
    return
  }

  for (const queued of pending) attach(info, queued)
  pending.length = 0
  attach(info, exchange)
}

function attach(info: TestInfo, exchange: McpExchange): void {
  if (info !== lastInfo) {
    lastInfo = info
    lastSeq = 0
  }

  lastSeq += 1
  const slug = exchange.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gv, '-')
    .replaceAll(/^-|-$/gv, '')
    .slice(0, 48)
  // In-memory attachments are persisted by Playwright; the returned promise
  // carries no data, so firing is sufficient here.
  void info.attach(`${String(lastSeq).padStart(2, '0')}-${slug}.png`, {
    body: Buffer.from(renderCapture(exchange)),
    contentType: 'image/png',
  })
}

export function renderCapture(exchange: McpExchange): Uint8Array {
  const tone = exchange.tone ?? 'ok'
  const bodyFont = `${BODY_LINE_HEIGHT - 6}px ${MONO_FAMILY}`

  // Measure with the exact font the body will be drawn in.
  const measure = createCanvas(8, 8).getContext('2d')
  measure.font = bodyFont
  const charWidth = measure.measureText('M').width
  const maxChars = Math.max(20, Math.floor((WIDTH - PADDING * 2) / charWidth))

  const lines: Array<{color: string; text: string}> = []
  const body = (text: string, color = '#c9d1d9'): void => {
    for (const line of wrap(text, maxChars)) lines.push({color, text: line})
  }

  const section = (label: string): void => {
    lines.push({color: '#79c0ff', text: `── ${label}`})
  }

  if (exchange.request !== undefined) {
    section('request')
    body(prettyJson(exchange.request), '#a5b4fc')
  }

  if (exchange.detail !== undefined || exchange.response !== undefined) {
    section('response')
    if (exchange.detail !== undefined) body(exchange.detail, '#f85149')
    if (exchange.response !== undefined) body(prettyJson(exchange.response))
  }

  if (lines.length === 0) body('(no payload)')

  const headerHeight = PADDING + 52
  const height = headerHeight + lines.length * BODY_LINE_HEIGHT + PADDING
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#0d1117'
  ctx.fillRect(0, 0, WIDTH, height)

  ctx.font = `600 15px ${MONO_FAMILY}`
  ctx.fillStyle = '#e6edf3'
  ctx.fillText(`▶ ${exchange.title}`, PADDING, PADDING + 10)

  const status = exchange.status ?? (tone === 'error' ? 'error' : 'OK')
  ctx.font = `600 13px ${MONO_FAMILY}`
  ctx.fillStyle = TONE_COLORS[tone]
  ctx.fillText(status, WIDTH - PADDING - ctx.measureText(status).width, PADDING + 9)

  const meta = [
    exchange.transport,
    exchange.durationMs === undefined ? undefined : `${exchange.durationMs} ms`,
    new Date().toISOString(),
  ]
    .filter((part) => part !== undefined)
    .join('  ·  ')
  ctx.font = `12px ${MONO_FAMILY}`
  ctx.fillStyle = '#8b949e'
  ctx.fillText(meta, PADDING, PADDING + 30)

  ctx.strokeStyle = '#30363d'
  ctx.beginPath()
  ctx.moveTo(PADDING, PADDING + 44)
  ctx.lineTo(WIDTH - PADDING, PADDING + 44)
  ctx.stroke()

  let y = headerHeight + BODY_LINE_HEIGHT - 4
  for (const line of lines) {
    ctx.font = bodyFont
    ctx.fillStyle = line.color
    ctx.fillText(line.text, PADDING, y)
    y += BODY_LINE_HEIGHT
  }

  return canvas.toBuffer('image/png')
}

function prettyJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }

  if (text.length > MAX_JSON_CHARS) {
    return `${text.slice(0, MAX_JSON_CHARS)}\n… truncated (${text.length} chars total)`
  }

  return text
}

function wrap(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    if (raw.length === 0) {
      out.push('')
      continue
    }

    for (let i = 0; i < raw.length; i += maxChars) out.push(raw.slice(i, i + maxChars))
  }

  return out
}
