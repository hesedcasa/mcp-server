import type {Config} from '@oclif/core/interfaces'

import {isCommandAllowed, readPermissionConfig} from '@hesed/permission'
import {buildKeywords} from '@hesed/plugin-lib'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js'

import {startHttpTransport} from './http-transport.js'
import {makeRunCommandHandler, makeSearchToolsHandler, type ToolHandler} from './tool-handlers.js'

// ts-prune-ignore-next
export async function createMcpServer(config: Config): Promise<McpServer> {
  const mcpServer = new McpServer({name: 'sdkck', version: config.version ?? '0.0.0'}, {capabilities: {tools: {}}})

  const permissionConfig = (config.configDir ? await readPermissionConfig(config.configDir) : null) ?? {
    allowRules: [{pattern: '*'}],
    denyRules: [],
  }
  const {jitPlugins = {}} = (config.pjson?.oclif ?? {}) as {jitPlugins?: Record<string, string>}

  const keywords = buildKeywords(config, jitPlugins, (commandId) => isCommandAllowed(commandId, permissionConfig))
  const searchToolsDescription = `Search for MCP tools with keywords: ${[...keywords].toSorted().join(' ')}`

  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        description: searchToolsDescription,
        inputSchema: {
          properties: {
            limit: {description: 'Maximum number of results (default 5)', type: 'number'},
            query: {description: 'Search query describing the task or command you are looking for', type: 'string'},
          },
          required: ['query'],
          type: 'object',
        },
        name: 'search_tools',
      },
      {
        description: 'Run a Sidekick command. Use "search_tools" first to discover commands and their arguments.',
        inputSchema: {
          properties: {
            args: {
              description: 'Command arguments as key-value pairs (e.g. {"issueId":"PROJ-123"})',
              type: 'object',
            },
            commandId: {
              description: 'The command ID to run (e.g. "jira issue get")',
              type: 'string',
            },
            flags: {
              description: 'Flag arguments as key-value pairs (e.g. {"limit":10,"verbose":true})',
              type: 'object',
            },
          },
          required: ['commandId'],
          type: 'object',
        },
        name: 'run_command',
      },
    ],
  }))

  const toolHandlers = new Map<string, ToolHandler>([
    ['run_command', makeRunCommandHandler(config)],
    ['search_tools', makeSearchToolsHandler(config)],
  ])

  mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {arguments: toolArgs, name} = request.params
    const handler = toolHandlers.get(name)
    if (!handler) {
      return {content: [{text: `Unknown tool: ${name}`, type: 'text' as const}], isError: true}
    }

    return handler(toolArgs ?? {})
  })

  return mcpServer
}

export async function startMcpServer(
  config: Config,
  options: {host?: string; port?: number; transport?: string} = {},
): Promise<void> {
  const {host = '127.0.0.1', port = 3000, transport = 'stdio'} = options

  if (transport === 'http') {
    await startHttpTransport(config, createMcpServer, {host, port})
    return
  }

  const server = await createMcpServer(config)
  const stdioTransport = new StdioServerTransport()
  await server.connect(stdioTransport)
}
