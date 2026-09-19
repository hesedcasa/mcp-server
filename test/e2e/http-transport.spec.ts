import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {expect, test} from '@playwright/test'

import {captureExchange} from './capture.js'
import {
  type HttpServerHandle,
  loadE2eConfig,
  makeWorkspaceDir,
  removeWorkspaceDir,
  runCli,
  spawnHttpServer,
} from './helpers.js'
import {expectSdkToolSuccess} from './mcp.fixture.js'

const config = loadE2eConfig()

function mcpUrl(port: number): URL {
  return new URL(`http://127.0.0.1:${port}/mcp`)
}

async function connectClient(port: number, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    mcpUrl(port),
    token ? {requestInit: {headers: {Authorization: `Bearer ${token}`}}} : undefined,
  )
  const client = new Client({name: 'playwright-e2e-runner', version: '1.0.0'}, {capabilities: {}})
  return client.connect(transport).then(() => client)
}

/** tools/call with a screenshot of the exchange attached to the test. */
async function callToolCaptured(client: Client, name: string, args: Record<string, unknown>) {
  const startedAt = Date.now()
  try {
    const result = await client.callTool({arguments: args, name})
    const isError = (result as {isError?: unknown}).isError === true
    captureExchange({
      durationMs: Date.now() - startedAt,
      request: {arguments: args, name},
      response: result,
      status: isError ? 'isError' : 'OK',
      title: `tools/call ${name}`,
      tone: isError ? 'warn' : 'ok',
      transport: 'http',
    })
    return result
  } catch (error) {
    captureExchange({
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      request: {arguments: args, name},
      status: 'error',
      title: `tools/call ${name}`,
      tone: 'error',
      transport: 'http',
    })
    throw error
  }
}

/** tools/list with a screenshot of the exchange attached to the test. */
async function listToolsCaptured(client: Client) {
  const startedAt = Date.now()
  try {
    const result = await client.listTools()
    captureExchange({
      durationMs: Date.now() - startedAt,
      response: result,
      status: 'OK',
      title: 'tools/list',
      tone: 'ok',
      transport: 'http',
    })
    return result
  } catch (error) {
    captureExchange({
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      status: 'error',
      title: 'tools/list',
      tone: 'error',
      transport: 'http',
    })
    throw error
  }
}

/** fetch with a screenshot of the raw HTTP exchange (Authorization redacted). */
async function capturedFetch(label: string, url: string | URL, init?: RequestInit): Promise<Response> {
  const startedAt = Date.now()
  const method = init?.method ?? 'GET'
  const href = typeof url === 'string' ? url : url.href
  try {
    const response = await fetch(url, init)
    let body: string
    try {
      body = await response.clone().text()
    } catch {
      body = '(body unavailable)'
    }

    captureExchange({
      durationMs: Date.now() - startedAt,
      request: {headers: redactHeaders(init?.headers), method, url: href},
      response: bodySnippet(body),
      status: `${response.status} ${response.statusText}`,
      title: label,
      tone: response.ok ? 'ok' : 'warn',
      transport: 'http',
    })
    return response
  } catch (error) {
    captureExchange({
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      request: {method, url: href},
      status: 'network error',
      title: label,
      tone: 'error',
      transport: 'http',
    })
    throw error
  }
}

function redactHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new Headers(headers)) {
    out[key] = key.toLowerCase() === 'authorization' ? `${value.slice(0, 7)}***` : value
  }

  return out
}

function bodySnippet(body: string): string {
  if (body.length <= 800) return body
  return `${body.slice(0, 800)}\n… truncated (${body.length} chars total)`
}

test.describe('MCP HTTP transport (Streamable HTTP)', () => {
  test.describe('without bearer auth', () => {
    let server: HttpServerHandle
    let workspace: string
    let client: Client

    test.beforeAll(async () => {
      workspace = await makeWorkspaceDir()
      server = await spawnHttpServer(config, workspace)
      client = await connectClient(server.port)
    })

    test.afterAll(async () => {
      await client?.close().catch(() => undefined)
      await server?.close()
      await removeWorkspaceDir(workspace)
    })

    test('completes the MCP handshake and lists tools over HTTP', async () => {
      const {tools} = await listToolsCaptured(client)
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(['run_command', 'search_tools'])
    })

    test('executes a tool over HTTP', async () => {
      const result = await callToolCaptured(client, 'run_command', {commandId: 'mcp token generate'})
      expect(result.isError).toBeUndefined()
      expect(expectSdkToolSuccess('run_command', result)).toMatch(/^[0-9a-f]{64}$/v)
    })

    test('answers 404 on unknown paths', async () => {
      const response = await capturedFetch('GET /wrong path', `http://127.0.0.1:${server.port}/wrong`)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('Not found')
    })

    test('answers 400 on GET without a session id', async () => {
      const response = await capturedFetch('GET /mcp without session id', mcpUrl(server.port))
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Invalid or missing session ID')
    })

    test('answers 400 on POST with malformed JSON', async () => {
      const response = await capturedFetch('POST /mcp malformed JSON', mcpUrl(server.port), {
        body: 'not json',
        headers: {'content-type': 'application/json'},
        method: 'POST',
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Invalid JSON')
    })

    test('answers 400 with a -32000 payload on POST before initialize', async () => {
      const response = await capturedFetch('POST /mcp before initialize', mcpUrl(server.port), {
        body: JSON.stringify({id: 1, jsonrpc: '2.0', method: 'ping'}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: {code: -32_000, message: 'Bad Request: expected initialize'},
        id: null,
        jsonrpc: '2.0',
      })
    })

    test('answers 405 on unsupported methods', async () => {
      const response = await capturedFetch('PUT /mcp', mcpUrl(server.port), {method: 'PUT'})
      expect(response.status).toBe(405)
      expect(await response.text()).toBe('Method not allowed')
    })
  })

  test.describe('with bearer auth', () => {
    let server: HttpServerHandle
    let workspace: string
    let cliToken: string
    let client: Client

    test.beforeAll(async () => {
      workspace = await makeWorkspaceDir()
      // The token is issued through the CLI surface and consumed over HTTP —
      // an oracle round-trip between the two transports.
      cliToken = await runCli(config, workspace, ['mcp:token:generate'])
      expect(cliToken).toMatch(/^[0-9a-f]{64}$/v)
      server = await spawnHttpServer(config, workspace)
      client = await connectClient(server.port, cliToken)
    })

    test.afterAll(async () => {
      await client?.close().catch(() => undefined)
      await server?.close()
      await removeWorkspaceDir(workspace)
    })

    test('rejects POST without a token (401 + WWW-Authenticate: Bearer)', async () => {
      const response = await capturedFetch('POST /mcp without token', mcpUrl(server.port), {
        body: JSON.stringify({id: 1, jsonrpc: '2.0', method: 'ping'}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
      expect(await response.text()).toBe('Unauthorized')
    })

    test('rejects POST with a wrong token (401)', async () => {
      const response = await capturedFetch('POST /mcp wrong token', mcpUrl(server.port), {
        body: JSON.stringify({id: 1, jsonrpc: '2.0', method: 'ping'}),
        headers: {Authorization: 'Bearer not-the-real-token', 'content-type': 'application/json'},
        method: 'POST',
      })
      expect(response.status).toBe(401)
    })

    test('refuses MCP client connections without credentials', async () => {
      const startedAt = Date.now()
      let failure: string
      try {
        await connectClient(server.port)
        failure = 'unexpectedly connected without credentials'
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      captureExchange({
        detail: failure,
        durationMs: Date.now() - startedAt,
        request: {url: mcpUrl(server.port).href},
        status: 'unauthorized',
        title: 'connect without credentials',
        tone: 'warn',
        transport: 'http',
      })
      expect(failure).toMatch(/Unauthorized/v)
    })

    test('authenticates with the CLI-issued token and round-trips it through run_command', async () => {
      const result = await callToolCaptured(client, 'run_command', {commandId: 'mcp token show'})
      expect(result.isError).toBeUndefined()
      expect(expectSdkToolSuccess('run_command', result)).toBe(cliToken)
    })
  })
})
