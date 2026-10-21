/**
 * Host half of the balance widget.
 *
 * The browser cannot reach `ctx.deepseekAccount` or the credential store
 * directly (both are Host-only), so this half owns every balance read:
 *
 * - `/plugins/dsh-balance-widget/balance`        one-shot DeepSeek wallets.
 * - `/plugins/dsh-balance-widget/relay-balance`  one-shot 302.AI relay balance.
 * - `/plugins/dsh-balance-widget/apiyi-balance`  one-shot APIYI balance.
 * - `/plugins/dsh-balance-widget/stream`         Server-Sent Events push.
 *
 * There is no clock-driven polling. A balance is read only when something that
 * can change it happened:
 *
 * - DeepSeek: a tool result (a model step finished consuming tokens), an agent
 *   going idle at turn end, or an account sign-out / expiry.
 * - 302.AI and APIYI: an image-generation tool result, or a credential change.
 *
 * Platform billing can lag behind the request that spent tokens, so every
 * event-triggered read is followed by one confirmation read one minute later.
 * Both reads push only when the visible value changed. Nothing secret (grant,
 * token, API key, headers) leaves the Host.
 */

import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Same-origin route for the signed-in DeepSeek account wallets. */
const BALANCE_ROUTE = '/plugins/dsh-balance-widget/balance'
/** Same-origin route for the 302.AI relay account balance. */
const RELAY_ROUTE = '/plugins/dsh-balance-widget/relay-balance'
/** Same-origin route for the APIYI account balance. */
const APIYI_ROUTE = '/plugins/dsh-balance-widget/apiyi-balance'
/** Same-origin Server-Sent Events route the Client subscribes to. */
const STREAM_ROUTE = '/plugins/dsh-balance-widget/stream'

/**
 * 302.AI's balance endpoint (`GET /dashboard/balance`, response
 * `{ "data": { "balance": "1.01" } }`). The public docs name
 * `https://api.302.ai`; the China entry point this machine can reach is
 * `https://api.302ai.cn`. Override either value from the launch environment.
 */
const RELAY_BASE_URL = process.env.DSH_BALANCE_WIDGET_RELAY_BASE || 'https://api.302ai.cn'
/** Credential reference the image-generation plugin stores its relay key under. */
const RELAY_CREDENTIAL_REF =
  process.env.DSH_BALANCE_WIDGET_RELAY_REF || 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY'
/** 302.AI reports this balance in US dollars. */
const RELAY_CURRENCY = 'USD'
/** Bound one relay request so a slow relay never stalls the widget. */
const RELAY_TIMEOUT_MS = 15000
/** Where a 302.AI balance click lands; override when the console route differs. */
const RELAY_TOPUP_URL =
  process.env.DSH_BALANCE_WIDGET_RELAY_TOPUP || 'https://dash.302ai.cn/user-center/charge'

/**
 * APIYI (API易) balance endpoint. It authenticates with a *personal access
 * token* (`nap_...`), not with the model API key, and reports quota units where
 * 500000 quota = 1 USD. The token is read from a local file because it is a
 * separate credential from every DSH-configured provider key.
 */
const APIYI_BALANCE_URL = 'https://api.apiyi.com/api/user/self'
/** Units of `quota` that equal one US dollar. */
const APIYI_QUOTA_PER_USD = 500000
/** Fallback APIYI console page; override with a direct recharge URL. */
const APIYI_TOPUP_URL =
  process.env.DSH_BALANCE_WIDGET_APIYI_TOPUP || 'https://api.apiyi.com/account/profile'
/** File holding the personal access token; one line, surrounding whitespace ignored. */
const APIYI_TOKEN_FILE =
  process.env.DSH_BALANCE_WIDGET_APIYI_TOKEN_FILE ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets', 'apiyi-token.txt')
/** Bound one APIYI balance request. */
const APIYI_TIMEOUT_MS = 15000

/** Fallback when the account read has not reported its own top-up link yet. */
const DEEPSEEK_TOPUP_FALLBACK = 'https://platform.deepseek.com/top_up'
/** Hosts the browser may be sent to for a top-up. */
const TOPUP_HOSTS = new Set([
  'platform.deepseek.com',
  'dash.302ai.cn',
  'dash.302.ai',
  '302.ai',
  'api.apiyi.com',
])

/** Coalesce the burst of events one model step produces into one read. */
const ACCOUNT_DEBOUNCE_MS = 2000
/** Give 302.AI billing a moment to settle after a generation completes. */
const RELAY_DEBOUNCE_MS = 4000
/** Confirmation read after the billing service had time to settle. */
const VERIFY_DELAY_MS = 60000
/** Comment heartbeat so an idle stream is never dropped as dead. */
const STREAM_KEEPALIVE_MS = 25000

/** Required Host services: the HTTP carrier and the account provider. */
export const inject = ['webServer', 'deepseekAccount']

/** Connected SSE responses. */
const streamClients = new Set()
/** Pending coalesced reads. */
let accountTimer = null
let relayTimer = null
let apiyiTimer = null
/** Pending one-shot confirmation reads. */
let accountVerifyTimer = null
let relayVerifyTimer = null
let apiyiVerifyTimer = null
/** Last pushed value per kind; a repeated read is not re-broadcast. */
let lastAccountKey = null
let lastRelayKey = null
let lastApiyiKey = null
/** Latest platform top-up link reported by the account read. */
let latestDeepSeekTopUp = null

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** Write one JSON response and end it. */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, JSON_HEADERS)
  res.end(body)
}

/**
 * Account metadata the account provider derives its Client identity headers
 * from. A browser request supplies its language; a background push uses the
 * Host default.
 */
function clientMetadata(req) {
  const header = req && req.headers ? req.headers['accept-language'] : undefined
  const first = typeof header === 'string' ? header.split(',')[0].trim() : ''
  return {
    version: '1.6.0',
    locale: first || 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/** Read the signed-in DeepSeek wallets, mapping every outcome to a stable wire shape. */
async function readBalance(ctx, client) {
  const [balance, state] = await Promise.all([
    ctx.deepseekAccount.getBalance(client).catch(() => ({ status: 'failed' })),
    ctx.deepseekAccount.getState().catch(() => null),
  ])
  const links = state && state.links ? state.links : null
  if (links && typeof links.topUpUrl === 'string' && links.topUpUrl.startsWith('https://')) {
    latestDeepSeekTopUp = links.topUpUrl
  }
  if (balance === null) {
    return { status: 'signed-out', fetchedAt: Date.now(), links }
  }
  if (balance.status !== 'ready') {
    return { status: 'failed', fetchedAt: Date.now(), links }
  }
  return {
    status: 'ready',
    fetchedAt: Date.now(),
    wallets: balance.value,
    bonusWallets: balance.bonusWallets,
    links,
  }
}

/** Resolve the relay API key, or undefined when no key is stored. */
async function resolveRelayKey(ctx) {
  const credentials = ctx.get('credentials')
  if (!credentials || typeof credentials.resolve !== 'function') return undefined
  try {
    const resolved = await credentials.resolve(RELAY_CREDENTIAL_REF)
    const value = resolved && typeof resolved.value === 'string' ? resolved.value.trim() : ''
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the 302.AI relay balance. `denied` means the key exists but its
 * permission set does not allow the dashboard balance API, which 302.AI
 * documents as a per-key permission.
 */
async function readRelayBalance(ctx) {
  const key = await resolveRelayKey(ctx)
  if (key === undefined) return { status: 'unconfigured', fetchedAt: Date.now() }
  const url = `${RELAY_BASE_URL.replace(/\/+$/, '')}/dashboard/balance`
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
    if (response.status === 403) return { status: 'denied', fetchedAt: Date.now() }
    if (!response.ok) {
      return { status: 'error', httpStatus: response.status, fetchedAt: Date.now() }
    }
    const payload = await response.json().catch(() => null)
    const value = payload && payload.data ? payload.data.balance : undefined
    if (typeof value !== 'string' && typeof value !== 'number') {
      return { status: 'error', fetchedAt: Date.now() }
    }
    return {
      status: 'ready',
      balance: String(value),
      currency: RELAY_CURRENCY,
      fetchedAt: Date.now(),
    }
  } catch {
    return { status: 'error', fetchedAt: Date.now() }
  }
}

/** Read the APIYI personal access token, or undefined when the file is absent. */
async function readApiyiToken() {
  try {
    const text = await readFile(APIYI_TOKEN_FILE, 'utf8')
    const token = text.trim().split(/\s+/)[0]
    return token && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the APIYI balance. `denied` covers the documented 401/403 cases: an
 * invalid or expired personal access token, or a token without the
 * "profile read" permission.
 */
async function readApiyiBalance() {
  const token = await readApiyiToken()
  if (token === undefined) return { status: 'unconfigured', fetchedAt: Date.now() }
  try {
    const response = await fetch(APIYI_BALANCE_URL, {
      headers: { authorization: token, accept: 'application/json' },
      signal: AbortSignal.timeout(APIYI_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) {
      return { status: 'denied', fetchedAt: Date.now() }
    }
    if (!response.ok) {
      return { status: 'error', httpStatus: response.status, fetchedAt: Date.now() }
    }
    const payload = await response.json().catch(() => null)
    const quota =
      payload && payload.success === true && payload.data
        ? Number(payload.data.quota)
        : Number.NaN
    if (!Number.isFinite(quota)) {
      return { status: 'denied', fetchedAt: Date.now() }
    }
    return {
      status: 'ready',
      balance: (quota / APIYI_QUOTA_PER_USD).toFixed(2),
      currency: 'USD',
      quota,
      fetchedAt: Date.now(),
    }
  } catch {
    return { status: 'error', fetchedAt: Date.now() }
  }
}

/** Change detection key: the parts a user can see, excluding the fetch time. */
function accountKey(data) {
  return JSON.stringify([data.status, data.wallets, data.bonusWallets])
}

/** Change detection key for the relay balance. */
function relayKey(data) {
  return JSON.stringify([data.status, data.balance || null, data.currency || null])
}

/** Change detection key for the APIYI balance. */
function apiyiKey(data) {
  return JSON.stringify([data.status, data.balance || null, data.currency || null])
}

/** Push one frame to every subscribed browser. */
function broadcast(kind, data) {
  const frame = `data: ${JSON.stringify({ kind, data })}\n\n`
  for (const res of streamClients) {
    try {
      res.write(frame)
    } catch {
      streamClients.delete(res)
    }
  }
}

/** Broadcast a read only when its visible value changed (or on connect). */
function publishAccount(data, force) {
  const key = accountKey(data)
  if (!force && key === lastAccountKey) return
  lastAccountKey = key
  broadcast('account', data)
}

/** Broadcast a relay read only when its visible value changed (or on connect). */
function publishRelay(data, force) {
  const key = relayKey(data)
  if (!force && key === lastRelayKey) return
  lastRelayKey = key
  broadcast('relay', data)
}

/** Broadcast an APIYI read only when its visible value changed (or on connect). */
function publishApiyi(data, force) {
  const key = apiyiKey(data)
  if (!force && key === lastApiyiKey) return
  lastApiyiKey = key
  broadcast('apiyi', data)
}

/** Arm the one-shot confirmation read that follows an event-triggered read. */
function armVerify(kind, ctx) {
  if (kind === 'account') {
    if (accountVerifyTimer) clearTimeout(accountVerifyTimer)
    accountVerifyTimer = setTimeout(() => {
      accountVerifyTimer = null
      void refreshAccount(ctx)
    }, VERIFY_DELAY_MS)
    return
  }
  if (kind === 'relay') {
    if (relayVerifyTimer) clearTimeout(relayVerifyTimer)
    relayVerifyTimer = setTimeout(() => {
      relayVerifyTimer = null
      void refreshRelay(ctx)
    }, VERIFY_DELAY_MS)
    return
  }
  if (apiyiVerifyTimer) clearTimeout(apiyiVerifyTimer)
  apiyiVerifyTimer = setTimeout(() => {
    apiyiVerifyTimer = null
    void refreshApiyi(ctx)
  }, VERIFY_DELAY_MS)
}

/** Read the account balance, push a change, and arm its confirmation read. */
async function refreshAccount(ctx, options = {}) {
  if (streamClients.size === 0) return
  const data = await readBalance(ctx, clientMetadata()).catch(() => null)
  if (!data || streamClients.size === 0) return
  publishAccount(data, options.force === true)
  if (options.verify === true) armVerify('account', ctx)
}

/** Read the relay balance, push a change, and arm its confirmation read. */
async function refreshRelay(ctx, options = {}) {
  if (streamClients.size === 0) return
  const data = await readRelayBalance(ctx).catch(() => null)
  if (!data || streamClients.size === 0) return
  publishRelay(data, options.force === true)
  if (options.verify === true) armVerify('relay', ctx)
}

/** Read the APIYI balance, push a change, and arm its confirmation read. */
async function refreshApiyi(ctx, options = {}) {
  if (streamClients.size === 0) return
  const data = await readApiyiBalance().catch(() => null)
  if (!data || streamClients.size === 0) return
  publishApiyi(data, options.force === true)
  if (options.verify === true) armVerify('apiyi', ctx)
}

/** Coalesce a burst of triggers into one event-triggered read per kind. */
function schedule(kind, ctx, delayMs) {
  if (kind === 'account') {
    if (accountTimer) return
    accountTimer = setTimeout(() => {
      accountTimer = null
      void refreshAccount(ctx, { verify: true })
    }, delayMs)
    return
  }
  if (kind === 'relay') {
    if (relayTimer) return
    relayTimer = setTimeout(() => {
      relayTimer = null
      void refreshRelay(ctx, { verify: true })
    }, delayMs)
    return
  }
  if (apiyiTimer) return
  apiyiTimer = setTimeout(() => {
    apiyiTimer = null
    void refreshApiyi(ctx, { verify: true })
  }, delayMs)
}

/** Whether a tool name belongs to an image-generation capability. */
function isImageTool(name) {
  if (typeof name !== 'string') return false
  return /generate_image|generate_images|edit_image|image_generate|image_edit/i.test(name)
}

/** Accept one SSE subscriber and push the current snapshot immediately. */
function openStream(ctx, req, res) {
  res.writeHead(200, STREAM_HEADERS)
  res.write(': connected\n\n')
  streamClients.add(res)
  const close = () => {
    streamClients.delete(res)
    try {
      res.end()
    } catch {
      // already closed
    }
  }
  req.on('close', close)
  res.on('close', close)
  void refreshAccount(ctx, { force: true })
  void refreshRelay(ctx, { force: true })
  void refreshApiyi(ctx, { force: true })
}

/** Answer one one-shot route with the shared method guard. */
function routeHandler(read) {
  return async (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, JSON_HEADERS)
      res.end()
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { status: 'error', message: 'method not allowed' })
      return
    }
    try {
      sendJson(res, 200, await read(req))
    } catch (error) {
      console.error('[dsh-balance-widget] balance read failed', error)
      sendJson(res, 500, { status: 'error', message: 'balance unavailable' })
    }
  }
}

/** Check one top-up destination against the allowlist. */
function allowedTopUpUrl(raw) {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      TOPUP_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/** Hand one allowlisted https URL to the operator's default browser. */
function openInBrowser(url) {
  if (!allowedTopUpUrl(url)) return false
  const command =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return true
  } catch (error) {
    console.error('[dsh-balance-widget] open top-up page failed', error)
    return false
  }
}

/** Register the routes, the change listeners, and the SSE keepalive. */
export function apply(ctx) {
  // The chip's context menu asks the Host to open a top-up page; the browser
  // itself never receives an arbitrary URL to launch.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-balance-widget/open-topup',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { status: 'error', message: 'method not allowed' })
            return
          }
          const kind = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('kind')
          const url =
            kind === 'relay'
              ? RELAY_TOPUP_URL
              : kind === 'apiyi'
                ? APIYI_TOPUP_URL
                : kind === 'deepseek'
                  ? latestDeepSeekTopUp || DEEPSEEK_TOPUP_FALLBACK
                  : null
          if (!url || !openInBrowser(url)) {
            sendJson(res, 400, { status: 'error', message: 'no top-up destination' })
            return
          }
          sendJson(res, 200, { status: 'ok', url })
        },
      }),
    'dsh-balance-widget: open top-up route',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: BALANCE_ROUTE,
        handler: routeHandler((req) => readBalance(ctx, clientMetadata(req))),
      }),
    'dsh-balance-widget: account balance route',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RELAY_ROUTE,
        handler: routeHandler(() => readRelayBalance(ctx)),
      }),
    'dsh-balance-widget: relay balance route',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: APIYI_ROUTE,
        handler: routeHandler(() => readApiyiBalance()),
      }),
    'dsh-balance-widget: apiyi balance route',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STREAM_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { status: 'error', message: 'method not allowed' })
            return
          }
          openStream(ctx, req, res)
        },
      }),
    'dsh-balance-widget: stream route',
  )

  // A finished tool call means the model step that produced it consumed tokens.
  ctx.effect(
    () =>
      ctx.on('tools/result', (exec) => {
        schedule('account', ctx, ACCOUNT_DEBOUNCE_MS)
        if (exec && isImageTool(exec.name)) {
          schedule('relay', ctx, RELAY_DEBOUNCE_MS)
          schedule('apiyi', ctx, RELAY_DEBOUNCE_MS)
        }
      }),
    'dsh-balance-widget: tool results',
  )

  // A turn that closes without tool calls still consumed tokens.
  ctx.effect(
    () =>
      ctx.on('agent/status', (payload) => {
        if (payload && payload.status === 'idle') schedule('account', ctx, ACCOUNT_DEBOUNCE_MS)
      }),
    'dsh-balance-widget: idle turns',
  )

  // Account state changes invalidate the displayed wallet immediately.
  ctx.effect(
    () =>
      ctx.on('deepseek-account/signed-out', () => {
        schedule('account', ctx, 0)
      }),
    'dsh-balance-widget: signed out',
  )
  ctx.effect(
    () =>
      ctx.on('deepseek-account/session-expired', () => {
        schedule('account', ctx, 0)
      }),
    'dsh-balance-widget: session expired',
  )

  // A replaced relay key invalidates the 302.AI balance immediately.
  ctx.effect(
    () =>
      ctx.on('credentials/reference-updated', (ref) => {
        if (String(ref) === RELAY_CREDENTIAL_REF) schedule('relay', ctx, 0)
      }),
    'dsh-balance-widget: relay credential',
  )

  // Saving a new personal access token re-reads the APIYI balance.
  ctx.effect(() => {
    let watcher
    try {
      watcher = watch(dirname(APIYI_TOKEN_FILE), (_event, filename) => {
        if (!filename || String(filename) === 'apiyi-token.txt') {
          schedule('apiyi', ctx, 500)
        }
      })
    } catch {
      return undefined
    }
    watcher.on('error', () => {})
    return () => {
      try {
        watcher.close()
      } catch {
        // already closed
      }
    }
  }, 'dsh-balance-widget: apiyi token watch')

  ctx.effect(() => {
    const keepalive = setInterval(() => {
      for (const res of streamClients) {
        try {
          res.write(': keepalive\n\n')
        } catch {
          streamClients.delete(res)
        }
      }
    }, STREAM_KEEPALIVE_MS)
    return () => {
      clearInterval(keepalive)
      if (accountTimer) clearTimeout(accountTimer)
      if (relayTimer) clearTimeout(relayTimer)
      if (apiyiTimer) clearTimeout(apiyiTimer)
      if (accountVerifyTimer) clearTimeout(accountVerifyTimer)
      if (relayVerifyTimer) clearTimeout(relayVerifyTimer)
      if (apiyiVerifyTimer) clearTimeout(apiyiVerifyTimer)
      accountTimer = null
      relayTimer = null
      apiyiTimer = null
      accountVerifyTimer = null
      relayVerifyTimer = null
      apiyiVerifyTimer = null
      lastAccountKey = null
      lastRelayKey = null
      lastApiyiKey = null
      for (const res of streamClients) {
        try {
          res.end()
        } catch {
          // already closed
        }
      }
      streamClients.clear()
    }
  }, 'dsh-balance-widget: stream lifecycle')
}
