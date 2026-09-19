import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {test as base, expect} from '@playwright/test'
import {join} from 'node:path'

import {captureExchange} from './capture.js'
import {
  type E2eConfig,
  loadE2eConfig,
  makeWorkspaceDir,
  type McpTextContent,
  type McpToolCallResult,
  removeWorkspaceDir,
  serverEnv,
} from './helpers.js'

/** A connected MCP client session over a spawned stdio server. */
export type McpSession = {
  /**
   * tools/call with normalized results and clean failure context: protocol
   * failures and malformed payloads throw with the tool name, the arguments,
   * and the server's stderr tail attached. Every exchange is screenshotted.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>
  readonly client: Client
  close(): Promise<void>
  readonly configDir: string
  getServerVersion(): ReturnType<Client['getServerVersion']>
  listTools(): ReturnType<Client['listTools']>
  ping(): ReturnType<Client['ping']>
}

/**
 * Spawns `node bin/run.js mcp:start` (stdio transport) against a throwaway
 * config dir and connects an MCP client to it.
 */
export async function startMcpSession(config: E2eConfig, configDir: string): Promise<McpSession> {
  const stderrTail: string[] = []
  let isClosed = false
  let client!: Client
  let transport: StdioClientTransport
  let isTransportClosed = false

  const spawnTransport = (): StdioClientTransport =>
    new StdioClientTransport({
      args: [...config.serverArgs, 'mcp:start'],
      command: config.serverCommand,
      cwd: config.projectRoot,
      env: serverEnv(configDir),
      stderr: 'pipe',
    })

  const connect = async (): Promise<void> => {
    transport = spawnTransport()
    // Set before connect: Protocol.connect chains this callback with its own.
    // StdioClientTransport exposes an onclose property, not an event emitter —
    // the same exception as src/http-transport.ts in the server itself.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = () => {
      isTransportClosed = true
    }

    client = new Client({name: 'playwright-e2e-runner', version: '1.0.0'}, {capabilities: {}})

    try {
      await client.connect(transport)
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw error
    }

    const stderr = transport.stderr as NodeJS.ReadableStream | undefined
    stderr?.setEncoding('utf8')
    stderr?.on('data', (chunk: string) => {
      stderrTail.push(chunk)
      if (stderrTail.length > 50) stderrTail.shift()
    })
    isTransportClosed = false
  }

  await connect()

  const captured = async <T>(title: string, request: unknown, run: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now()
    try {
      const response = await run()
      captureExchange({
        durationMs: Date.now() - startedAt,
        request,
        response,
        status: 'OK',
        title,
        tone: 'ok',
        transport: 'stdio',
      })
      return response
    } catch (error) {
      captureExchange({
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        request,
        status: 'error',
        title,
        tone: 'error',
        transport: 'stdio',
      })
      throw error
    }
  }

  /**
   * Restarts the server when the previous host process died. A plugin command
   * executed in-process can terminate the host (e.g. api2cli's commands exit
   * cleanly right after responding) — without this, one plugin's crash would
   * fail every later test in the worker with "Not connected".
   */
  const ensureAlive = async (): Promise<void> => {
    if (!isTransportClosed || isClosed) {
      return
    }

    stderrTail.length = 0
    await connect()
  }

  return {
    async callTool(name, args = {}): Promise<McpToolCallResult> {
      await ensureAlive()
      const startedAt = Date.now()
      let raw: unknown
      try {
        raw = await client.callTool({arguments: args, name})
      } catch (error) {
        // The host may have died handling this very call — recover for the
        // tests after this one, then surface the failure with its stderr.
        await ensureAlive()
        captureExchange({
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          request: {arguments: args, name},
          status: 'protocol error',
          title: `tools/call ${name}`,
          tone: 'error',
          transport: 'stdio',
        })
        throw new Error(
          `MCP tools/call "${name}" failed at the protocol level: ${error instanceof Error ? error.message : String(error)}\n` +
            `  arguments: ${JSON.stringify(args)}\n` +
            `  server stderr (tail):\n${stderrTail.join('').trimEnd()}`,
          {cause: error},
        )
      }

      const isError = (raw as {isError?: unknown}).isError === true
      captureExchange({
        durationMs: Date.now() - startedAt,
        request: {arguments: args, name},
        response: raw,
        status: isError ? 'isError' : 'OK',
        title: `tools/call ${name}`,
        tone: isError ? 'warn' : 'ok',
        transport: 'stdio',
      })
      return normalizeToolResult(name, raw)
    },
    client,
    async close(): Promise<void> {
      if (isClosed) return
      isClosed = true
      await transport.close()
    },
    configDir,
    getServerVersion() {
      const response = client.getServerVersion()
      captureExchange({response, status: 'OK', title: 'getServerVersion', tone: 'ok', transport: 'stdio'})
      return response
    },
    async listTools() {
      await ensureAlive()
      return captured('tools/list', undefined, async () => client.listTools())
    },
    async ping() {
      await ensureAlive()
      return captured('ping', undefined, async () => client.ping())
    },
  }
}

/**
 * Normalizes a raw (SDK-typed) tools/call result and asserts a successful
 * single-text-block payload — for callers that bypass the session wrapper
 * (e.g. the HTTP leg using StreamableHTTPClientTransport directly).
 */
export function expectSdkToolSuccess(toolName: string, raw: unknown): string {
  return expectToolSuccess(normalizeToolResult(toolName, raw))
}

/**
 * Asserts a tools/call result is a successful single-text-block payload and
 * returns its text. Failure messages include the full result for quick triage.
 */
export function expectToolSuccess(result: McpToolCallResult): string {
  expect(result, `expected a successful tool result, got: ${JSON.stringify(result)}`).not.toHaveProperty(
    'isError',
    true,
  )
  expect(result.content, `expected text content, got: ${JSON.stringify(result)}`).toHaveLength(1)
  const [block] = result.content
  expect(block.type).toBe('text')
  return block.text
}

/** Asserts the server reported an application-level error containing `substring`. */
export function expectToolError(result: McpToolCallResult, substring: string): string {
  expect(result, `expected an isError tool result, got: ${JSON.stringify(result)}`).toHaveProperty('isError', true)
  expect(result.content, `expected text content, got: ${JSON.stringify(result)}`).toHaveLength(1)
  const [block] = result.content
  expect(block.type).toBe('text')
  expect(block.text, `error text should mention "${substring}"`).toContain(substring)
  return block.text
}

function normalizeToolResult(name: string, raw: unknown): McpToolCallResult {
  const result = raw as {content?: unknown; isError?: unknown}
  if (!Array.isArray(result.content)) {
    throw new TypeError(
      `MCP tools/call "${name}" returned malformed content (expected an array): ${JSON.stringify(raw)}`,
    )
  }

  const content = result.content.map((block): McpTextContent => {
    const candidate = block as {text?: unknown; type?: unknown}
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') {
      throw new Error(`MCP tools/call "${name}" returned a non-text content block: ${JSON.stringify(block)}`)
    }

    return {text: candidate.text, type: 'text'}
  })
  return result.isError === true ? {content, isError: true} : {content}
}

export const test = base.extend<
  Record<string, unknown>,
  {
    /** Stdio MCP session shared by the tests in this worker (one server per worker). */
    mcp: McpSession
    /** Throwaway oclif config dir (MCP_SERVER_CONFIG_DIR) for this worker. */
    mcpWorkspace: string
  }
>({
  mcp: [
    async ({mcpWorkspace}, use) => {
      const session = await startMcpSession(loadE2eConfig(), mcpWorkspace)
      await use(session)
      await session.close()
    },
    {scope: 'worker'},
  ],
  mcpWorkspace: [
    // Playwright requires fixture functions to destructure their first argument.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // Host leg: the shared throwaway sdkck home's config dir, seeded by
      // scripts/e2e.sh / the plugins spec with the plugins' auth profiles.
      const home = process.env.E2E_SDKCK_HOME
      const dir = home ? join(home, 'config') : await makeWorkspaceDir()
      await use(dir)
      if (!home) await removeWorkspaceDir(dir)
    },
    {scope: 'worker'},
  ],
})
