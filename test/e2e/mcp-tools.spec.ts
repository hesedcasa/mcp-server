import {expect} from '@playwright/test'

import {loadE2eConfig, makeWorkspaceDir, RawJsonRpcClient, removeWorkspaceDir, writePermissionRules} from './helpers.js'
import {expectToolError, expectToolSuccess, startMcpSession, test} from './mcp.fixture.js'

/** Declared TypeScript contract for the search_tools tool input. */
type SearchToolsInput = {
  limit?: number
  query: string
}

/** Declared TypeScript contract for the run_command tool input. */
type RunCommandInput = {
  args?: Record<string, unknown>
  commandId: string
  flags?: Record<string, unknown>
}

/**
 * The tools/list schema contract, mirrored from the discovered JSON Schema so
 * a drift between the server and the TypeScript surface fails loudly here.
 */
const EXPECTED_TOOL_SCHEMAS: Record<string, {propertyTypes: Record<string, string>; required: string[]}> = {
  run_command: {
    propertyTypes: {args: 'object', commandId: 'string', flags: 'object'},
    required: ['commandId'],
  },
  search_tools: {
    propertyTypes: {limit: 'number', query: 'string'},
    required: ['query'],
  },
}

test.describe('MCP Server End-to-End Tool Execution Specs', () => {
  test.describe('Discovery & schema mapping', () => {
    test('lists every server tool with a non-empty description', async ({mcp}) => {
      const {tools} = await mcp.listTools()
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(Object.keys(EXPECTED_TOOL_SCHEMAS).toSorted())
      for (const tool of tools) {
        expect(tool.description, `tool "${tool.name}" should have a description`).toBeTruthy()
      }
    })

    test('declares a JSON-Schema object input for every tool', async ({mcp}) => {
      const {tools} = await mcp.listTools()
      for (const tool of tools) {
        expect(tool.inputSchema.type, `tool "${tool.name}" inputSchema.type`).toBe('object')
        expect(Object.keys(tool.inputSchema.properties ?? {}), `tool "${tool.name}" properties`).not.toHaveLength(0)
        const properties = tool.inputSchema.properties ?? {}
        for (const required of tool.inputSchema.required ?? []) {
          expect(properties, `tool "${tool.name}" required "${required}" must be a declared property`).toHaveProperty(
            required,
          )
        }
      }
    })

    test('tool parameters match their declared TypeScript contracts', async ({mcp}) => {
      const {tools} = await mcp.listTools()
      for (const tool of tools) {
        const expected = EXPECTED_TOOL_SCHEMAS[tool.name]
        expect(expected, `unexpected tool "${tool.name}" (update EXPECTED_TOOL_SCHEMAS)`).toBeTruthy()
        expect(tool.inputSchema.required, `tool "${tool.name}" required`).toEqual(expected.required)
        const properties: Record<string, {description?: string; type?: string}> = tool.inputSchema.properties ?? {}
        expect(Object.keys(properties).toSorted(), `tool "${tool.name}" property names`).toEqual(
          Object.keys(expected.propertyTypes).toSorted(),
        )
        for (const [property, type] of Object.entries(expected.propertyTypes)) {
          expect(properties[property]?.type, `tool "${tool.name}" property "${property}" type`).toBe(type)
        }
      }
    })

    test('reports server identity metadata', async ({mcp}) => {
      const info = mcp.getServerVersion()
      expect(info).toBeDefined()
      expect(info?.name).toBe('sdkck')
      expect(info?.version, 'server version should be the package version').toBeTruthy()
    })

    test('responds to ping', async ({mcp}) => {
      expect(await mcp.ping()).toEqual({})
    })
  })

  test.describe('Tool: search_tools', () => {
    // Standalone this plugin ships no `search` command (it exists once the
    // plugin is co-installed into the sdkck host), so the positive path here
    // is the documented degraded answer — a safe isError payload. On the host
    // leg the real search command exists; plugins.e2e.spec.ts covers it.
    test.skip(Boolean(process.env.E2E_HOST_CLI), 'standalone leg only — the host has a real search command')

    test('answers a valid query with the degraded-path notice', async ({mcp}) => {
      const input: SearchToolsInput = {query: 'token'}
      const text = expectToolError(await mcp.callTool('search_tools', input), 'Search command not available')
      expect(text).toBeTruthy()
    })

    test('accepts the optional numeric limit argument', async ({mcp}) => {
      const input: SearchToolsInput = {limit: 3, query: 'token'}
      const result = await mcp.callTool('search_tools', input)
      // Same degraded answer: proves the optional number parsed and routed.
      expectToolError(result, 'Search command not available')
    })
  })

  test.describe('Tool: run_command — positive paths', () => {
    test('generates a 64-character hex bearer token', async ({mcp}) => {
      const input: RunCommandInput = {commandId: 'mcp token generate'}
      const text = expectToolSuccess(await mcp.callTool('run_command', input))
      expect(text).toMatch(/^[0-9a-f]{64}$/v)
    })

    test('token lifecycle: show round-trips the generated token, delete revokes it', async ({mcp}) => {
      const generated = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'mcp token generate'}))
      expect(generated).toMatch(/^[0-9a-f]{64}$/v)

      const shown = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'mcp token show'}))
      expect(shown, 'show should return the same token generate produced').toBe(generated)

      const deleted = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'mcp token delete'}))
      expect(deleted).toContain('MCP token removed')

      const afterDelete = await mcp.callTool('run_command', {commandId: 'mcp token show'})
      expectToolError(afterDelete, 'No MCP token configured')
    })

    test('deleting an absent token stays idempotent', async ({mcp}) => {
      await mcp.callTool('run_command', {commandId: 'mcp token delete'})
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'mcp token delete'}))
      expect(text).toContain('MCP token removed')
    })

    test('accepts colon-separated canonical command IDs', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'mcp:token:generate'}))
      expect(text).toMatch(/^[0-9a-f]{64}$/v)
    })
  })

  test.describe('Tool: run_command — negative paths', () => {
    test('unknown command returns a safe isError payload with guidance', async ({mcp}) => {
      const text = expectToolError(
        await mcp.callTool('run_command', {commandId: 'totally bogus command'}),
        'Unknown command',
      )
      expect(text).toContain('totally bogus command')
      expect(text).toContain('search_tools')
    })

    test('missing required commandId degrades to the unknown-command payload', async ({mcp}) => {
      // The handler treats a missing commandId as empty and the lookup fails
      // safely — an application-level isError result, not a protocol crash.
      expectToolError(await mcp.callTool('run_command', {}), 'Unknown command: ""')
    })

    test('unknown tool name routes to the app-level error payload', async ({mcp}) => {
      expectToolError(await mcp.callTool('no_such_tool', {}), 'Unknown tool: no_such_tool')
    })
  })

  test.describe('Permission gating', () => {
    // Deny patterns match on the space-separated display form AND the colon
    // form: the runtime topic separator differs between legs (standalone
    // mcp-server resolves colons, the released sdkck host resolves spaces).
    test('a deny rule blocks the command while allow rules keep the rest usable', async () => {
      const dir = await makeWorkspaceDir()
      try {
        await writePermissionRules(dir, {
          allowRules: [{pattern: '*'}],
          denyRules: [{pattern: 'mcp:token:show'}, {pattern: 'mcp token show'}],
        })
        const session = await startMcpSession(loadE2eConfig(), dir)
        try {
          const denied = await session.callTool('run_command', {commandId: 'mcp token show'})
          expectToolError(denied, 'is blocked by the permission list')
          const allowed = await session.callTool('run_command', {commandId: 'mcp token generate'})
          expectToolSuccess(allowed)
        } finally {
          await session.close()
        }
      } finally {
        await removeWorkspaceDir(dir)
      }
    })
  })

  test.describe('JSON-RPC 2.0 wire conformance (raw stdio)', () => {
    const config = loadE2eConfig()
    let raw: RawJsonRpcClient

    test.beforeAll(async ({mcpWorkspace}) => {
      raw = new RawJsonRpcClient(config, mcpWorkspace)
      const init = await raw.initialize(config)
      expect(init.result).toHaveProperty('serverInfo')
    })

    test.afterAll(async () => {
      await raw.close()
    })

    test('answers ping with an empty result object', async () => {
      const response = await raw.request('ping', {}, config)
      expect(response.error).toBeUndefined()
      expect(response.result).toEqual({})
    })

    test('unknown method returns -32601 Method not found', async () => {
      const response = await raw.request('mcp/e2e/nonexistent', {}, config)
      expect(response.result).toBeUndefined()
      expect(response.error?.code).toBe(-32_601)
      expect(response.error?.message).toContain('Method not found')
    })

    test('malformed tools/call arguments return a structured JSON-RPC error', async () => {
      // The MCP spec maps invalid params to Invalid params (-32602); the SDK's
      // zod pipeline surfaces the same failure as Internal error (-32603) with
      // the validation issues embedded in the message. The contract asserted
      // here: a well-formed JSON-RPC error response, a numeric code, and no
      // server crash.
      const response = await raw.request('tools/call', {arguments: 42, name: 'run_command'}, config)
      expect(response.result).toBeUndefined()
      expect(response.error?.code).toBe(-32_603)
      expect(response.error?.message).toContain('arguments')
    })
  })
})
