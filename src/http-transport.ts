import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {Config} from '@oclif/core/interfaces'

// eslint-disable-next-line import/no-unresolved
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
// eslint-disable-next-line import/no-unresolved
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js'
import {randomUUID} from 'node:crypto'
import * as http from 'node:http'

import {checkBearerToken, readMcpAuth} from './mcp-auth.js'

export async function startHttpTransport(
  config: Config,
  createServer: (config: Config) => Promise<McpServer>,
  options: {host: string; port: number},
): Promise<void> {
  const {host, port} = options
  const token = config.configDir ? await readMcpAuth(config.configDir) : null
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('Not found')
      return
    }

    if (token && !checkBearerToken(req, res, token)) return

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (req.method === 'GET') {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400).end('Invalid or missing session ID')
        return
      }

      await transports.get(sessionId)!.handleRequest(req, res)
      return
    }

    if (req.method === 'POST') {
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res)
        return
      }

      let body: unknown
      try {
        body = await new Promise<unknown>((resolve, reject) => {
          let raw = ''
          req.on('data', (chunk: string) => {
            raw += chunk
          })
          req.on('end', () => {
            try {
              resolve(JSON.parse(raw))
            } catch {
              reject(new Error('Invalid JSON'))
            }
          })
          req.on('error', reject)
        })
      } catch {
        res.writeHead(400).end('Invalid JSON')
        return
      }

      if (!isInitializeRequest(body)) {
        res.writeHead(400).end(
          JSON.stringify({
            error: {code: -32_000, message: 'Bad Request: expected initialize'},
            id: null,
            jsonrpc: '2.0',
          }),
        )
        return
      }

      const mcpTransport = new StreamableHTTPServerTransport({
        onsessioninitialized(sid) {
          transports.set(sid, mcpTransport)
        },
        sessionIdGenerator: () => randomUUID(),
      })

      // eslint-disable-next-line unicorn/prefer-add-event-listener
      mcpTransport.onclose = () => {
        if (mcpTransport.sessionId) transports.delete(mcpTransport.sessionId)
      }

      const mcpServerInstance = await createServer(config)
      await mcpServerInstance.connect(mcpTransport)
      await mcpTransport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'DELETE') {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400).end('Invalid or missing session ID')
        return
      }

      await transports.get(sessionId)!.close()
      res.writeHead(200).end()
      return
    }

    res.writeHead(405).end('Method not allowed')
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject)
    httpServer.listen(port, host, resolve)
  })
  process.stderr.write(`MCP server listening on http://${host}:${port}\n`)
  process.stderr.write(`  Endpoint: /mcp\n`)
  if (token) process.stderr.write(`  Authentication: Bearer token required\n`)

  await new Promise<void>((_, reject) => {
    httpServer.on('error', reject)
  })
}
