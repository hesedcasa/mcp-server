import {type ChildProcess, execFile, spawn} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {captureExchange} from './capture.js'

/** Every knob the suite needs, resolved from the environment (see loadE2eConfig). */
export type E2eConfig = {
  /** Absolute path (or PATH name) of the sdkck host CLI; empty on the standalone leg. */
  readonly hostCli: string
  /** Fixed port for the HTTP leg; random free port when unset. */
  readonly httpPort?: number
  /** Node executable used to launch the server / CLI (standalone leg). */
  readonly nodeCommand: string
  /** Repo root; spawned servers run with this cwd. */
  readonly projectRoot: string
  /** How long to wait for a spawned server to answer a request. */
  readonly requestTimeoutMs: number
  /** The throwaway sdkck home (E2E_SDKCK_HOME); empty on the standalone leg. */
  readonly sdkckHome: string
  readonly serverArgs: string[]
  /** What to spawn: [node, bin/run.js] standalone, or the sdkck host binary. */
  readonly serverCommand: string
  /** oclif runner script, relative to projectRoot (colon topic form, e.g. "mcp:start"). */
  readonly serverEntry: string
  /** How long to wait for the HTTP leg to print its listening line. */
  readonly startTimeoutMs: number
}

export type PermissionRules = {
  allowRules: Array<{pattern: string}>
  denyRules: Array<{pattern: string}>
}

/** Content block of a tools/call result, narrowed to the text variant the server emits. */
export type McpTextContent = {
  text: string
  type: 'text'
}

/** Normalized tools/call result (MCP spec: result.content array, optional isError flag). */
export type McpToolCallResult = {
  content: McpTextContent[]
  isError?: true
}

/** Tool descriptor as returned by tools/list (the subset the suite asserts on). */
export type McpToolDescriptor = {
  description?: string
  inputSchema: {
    properties?: Record<string, {description?: string; type?: string}>
    required?: string[]
    type: string
  }
  name: string
}

export function loadE2eConfig(): E2eConfig {
  const projectRoot = process.env.E2E_PROJECT_ROOT
    ? resolve(process.env.E2E_PROJECT_ROOT)
    : resolve(import.meta.dirname, '../..')
  const port = process.env.E2E_HTTP_PORT ? Number(process.env.E2E_HTTP_PORT) : undefined
  // Host leg (E2E_HOST_CLI=sdkck, set by scripts/e2e.sh): the MCP server runs
  // through the sdkck host with every @hesed plugin installed, so run_command
  // can execute the imported plugins' real commands.
  const hostCli = process.env.E2E_HOST_CLI ?? ''
  const nodeCommand = process.env.E2E_NODE ?? process.execPath
  const serverEntry = process.env.E2E_SERVER_ENTRY ?? 'bin/run.js'
  return {
    hostCli,
    httpPort: Number.isFinite(port) ? port : undefined,
    nodeCommand,
    projectRoot,
    requestTimeoutMs: process.env.E2E_REQUEST_TIMEOUT_MS ? Number(process.env.E2E_REQUEST_TIMEOUT_MS) : 15_000,
    sdkckHome: process.env.E2E_SDKCK_HOME ?? '',
    serverArgs: hostCli ? [] : [serverEntry],
    serverCommand: hostCli || nodeCommand,
    serverEntry,
    startTimeoutMs: process.env.E2E_START_TIMEOUT_MS ? Number(process.env.E2E_START_TIMEOUT_MS) : 15_000,
  }
}

/** Spawn env for a server/CLI process: inherit the runner env, redirect oclif's bin-scoped dirs. */
export function serverEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }

  // oclif scopes these to the bin name (mcp-server → MCP_SERVER_*), the same
  // throwaway-home pattern the sdkck e2e suites use. On the host leg the
  // running bin is sdkck, so its own scoped vars redirect config/data/cache.
  env.MCP_SERVER_CONFIG_DIR = configDir
  const sdkckHome = process.env.E2E_SDKCK_HOME
  if (sdkckHome) {
    env.SDKCK_CONFIG_DIR = configDir
    env.SDKCK_DATA_DIR = join(sdkckHome, 'data')
    env.SDKCK_CACHE_DIR = join(sdkckHome, 'cache')
  }

  return env
}

export async function makeWorkspaceDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mcp-server-e2e-'))
}

export async function removeWorkspaceDir(dir: string): Promise<void> {
  await rm(dir, {force: true, recursive: true})
}

/** Writes <configDir>/permission.json — the raw file is the oracle, not the CLI under test. */
export async function writePermissionRules(configDir: string, rules: PermissionRules): Promise<void> {
  await writeFile(join(configDir, 'permission.json'), JSON.stringify({version: 1, ...rules}, null, 2), 'utf8')
}

/** Runs one CLI invocation (`node bin/run.js <args…>`) against the given config dir. */
export async function runCli(config: E2eConfig, configDir: string, args: string[]): Promise<string> {
  const startedAt = Date.now()
  let stdout: string
  try {
    stdout = await new Promise<string>((resolveRun, rejectRun) => {
      execFile(
        config.serverCommand,
        [...config.serverArgs, ...args],
        {cwd: config.projectRoot, encoding: 'utf8', env: serverEnv(configDir), timeout: config.requestTimeoutMs},
        (error, execStdout, execStderr) => {
          if (error) {
            rejectRun(new Error(`CLI ${args.join(' ')} failed: ${error.message}\n${execStderr}`))
            return
          }

          resolveRun(execStdout.trim())
        },
      )
    })
  } catch (error) {
    captureExchange({
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      request: {args},
      status: 'failed',
      title: `cli ${args.join(' ')}`,
      tone: 'error',
      transport: 'cli',
    })
    throw error
  }

  captureExchange({
    durationMs: Date.now() - startedAt,
    request: {args},
    response: stdout,
    status: 'exit 0',
    title: `cli ${args.join(' ')}`,
    tone: 'ok',
    transport: 'cli',
  })
  return stdout
}

/** Binds an ephemeral port and releases it for the HTTP leg to listen on. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const {port} = srv.address() as {port: number}
      srv.close(() => {
        resolvePort(port)
      })
    })
    srv.on('error', rejectPort)
  })
}

type RawResponse = {
  error?: {code: number; message: string}
  id?: number | string | undefined
  result?: Record<string, unknown>
}

/** A running HTTP-transport server plus the port it listens on. */
export type HttpServerHandle = {
  close(): Promise<void>
  port: number
}

/**
 * Spawns `node bin/run.js mcp:start --transport http` against the given
 * config dir and resolves once the server prints its listening line.
 */
export async function spawnHttpServer(config: E2eConfig, configDir: string): Promise<HttpServerHandle> {
  const port = config.httpPort ?? (await findFreePort())
  const child = spawn(
    config.serverCommand,
    [...config.serverArgs, 'mcp:start', '--transport', 'http', '--port', String(port)],
    {cwd: config.projectRoot, env: serverEnv(configDir), stdio: ['pipe', 'pipe', 'pipe']},
  )

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (stderr.length > 8192) stderr = stderr.slice(-4096)
  })

  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(
        new Error(`HTTP server not ready on port ${port} within ${config.startTimeoutMs}ms\nstderr:\n${stderr}`),
      )
    }, config.startTimeoutMs)
    const poll = setInterval(() => {
      if (!(stderr.includes(`listening on http://`) && stderr.includes(`:${port}`))) {
        return
      }

      cleanup()
      resolveReady()
    }, 50)
    const onExit = (code: number | undefined) => {
      cleanup()
      rejectReady(new Error(`HTTP server exited before listening (code ${code})\nstderr:\n${stderr}`))
    }

    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(poll)
      child.off('exit', onExit)
    }

    child.once('exit', onExit)
  })

  return {
    close: async () =>
      new Promise<void>((resolveClose) => {
        child.once('exit', () => {
          resolveClose()
        })
        child.kill('SIGTERM')
        setTimeout(() => {
          child.kill('SIGKILL')
          resolveClose()
        }, 5000)
      }),
    port,
  }
}

/**
 * Speaks newline-delimited JSON-RPC 2.0 to a spawned stdio server without the
 * MCP client, so wire-level conformance (error codes, framing) is testable.
 */
export class RawJsonRpcClient {
  private buffer = ''
  private readonly child: ChildProcess
  private nextId = 1
  private readonly pending = new Map<number, (response: RawResponse) => void>()
  private readonly stderr: string[] = []

  constructor(config: E2eConfig, configDir: string, args: string[] = ['mcp:start']) {
    this.child = spawn(config.serverCommand, [...config.serverArgs, ...args], {
      cwd: config.projectRoot,
      env: serverEnv(configDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.dispatch(line)
      }
    })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr.push(chunk)
      if (this.stderr.length > 50) this.stderr.shift()
    })
  }

  async close(): Promise<void> {
    this.child.stdin!.end()
    this.child.kill('SIGTERM')
    await new Promise<void>((resolveClose) => {
      if (this.child.exitCode !== null) {
        resolveClose()
        return
      }

      this.child.once('exit', () => {
        resolveClose()
      })
      setTimeout(() => {
        this.child.kill('SIGKILL')
        resolveClose()
      }, 5000)
    })
  }

  async initialize(config: E2eConfig): Promise<RawResponse> {
    const response = await this.request(
      'initialize',
      {capabilities: {}, clientInfo: {name: 'playwright-e2e-runner', version: '1.0.0'}, protocolVersion: '2025-06-18'},
      config,
    )
    this.notify('notifications/initialized')
    return response
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin!.write(`${JSON.stringify({jsonrpc: '2.0', method, params})}\n`)
  }

  async request(method: string, params: Record<string, unknown>, config: E2eConfig): Promise<RawResponse> {
    const id = this.nextId++
    const startedAt = Date.now()
    let response: RawResponse | undefined
    try {
      response = await new Promise<RawResponse>((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          rejectRequest(
            new Error(
              `No JSON-RPC response for "${method}" within ${config.requestTimeoutMs}ms\nstderr:\n${this.stderr.join('')}`,
            ),
          )
        }, config.requestTimeoutMs)
        this.pending.set(id, (message) => {
          clearTimeout(timer)
          resolveRequest(message)
        })
        this.child.stdin!.write(`${JSON.stringify({id, jsonrpc: '2.0', method, params})}\n`)
      })
    } catch (error) {
      captureExchange({
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        request: {id, method, params},
        status: 'no response',
        title: method,
        tone: 'error',
        transport: 'jsonrpc-raw',
      })
      throw error
    }

    captureExchange({
      durationMs: Date.now() - startedAt,
      request: {id, method, params},
      response,
      status: response.error ? `error ${response.error.code}` : 'OK',
      title: method,
      tone: response.error ? 'error' : 'ok',
      transport: 'jsonrpc-raw',
    })
    return response
  }

  // unicorn wants private methods first; perfectionist/sort-classes (the autofixable
  // rule) wants them last — the two conflict for any class with private methods.
  // eslint-disable-next-line unicorn/consistent-class-member-order
  private dispatch(line: string): void {
    try {
      const message = JSON.parse(line) as RawResponse
      if (message.id !== undefined && message.id !== null) {
        const resolvePending = this.pending.get(Number(message.id))
        if (resolvePending) {
          this.pending.delete(Number(message.id))
          resolvePending(message)
        }
      }
    } catch {
      // Non-JSON stdout line — the protocol is broken; tests will time out.
    }
  }
}
