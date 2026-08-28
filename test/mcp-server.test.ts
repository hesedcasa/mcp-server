import type {Command} from '@oclif/core'
import type {Config} from '@oclif/core/interfaces'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {expect} from 'chai'

import {createMcpServer} from '../src/mcp-server.js'

type CallToolResult = {content: [{text: string}]; isError?: boolean}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function cmd(overrides: Record<string, unknown>): Command.Loadable {
  const loadable = {
    args: {},
    description: '',
    flags: {},
    hidden: false,
    id: '',
    pluginName: 'sdkck',
    summary: '',
    ...overrides,
  }
  return loadable as never
}

const SEARCH_CMD = cmd({
  args: {query: {description: 'Search term', name: 'query', required: true}},
  flags: {
    details: {description: 'Show full help', required: false, type: 'boolean'},
    limit: {description: 'Max results', required: false, type: 'option'},
  },
  id: 'search',
  summary: 'Search for available commands',
})

const IMPORT_CMD = cmd({
  args: {source: {description: 'Path or URL', name: 'source', required: true}},
  flags: {name: {description: 'Override spec name', required: false, type: 'option'}},
  id: 'api:import',
  summary: 'Import an OpenAPI spec',
})

const PETSTORE_CMD = cmd({
  flags: {
    header: {description: 'Extra header', multiple: true, required: false, type: 'option'},
    limit: {description: 'Max results', required: false, type: 'option'},
  },
  id: 'petstore:listPets',
  summary: 'List all pets',
})

const ALL_COMMANDS = [SEARCH_CMD, IMPORT_CMD, PETSTORE_CMD]

function makeMockConfig(commands: Command.Loadable[]): Config {
  const config = {
    commands,
    name: 'sdkck',
    runHook: async () => ({failures: [], successes: []}),
    topicSeparator: ' ',
    version: '1.0.0',
  }
  return config as unknown as Config
}

/** Connects a fresh server+client pair via in-memory transport. */
async function makeClient(commands: Command.Loadable[]): Promise<Client> {
  const config = makeMockConfig(commands)
  const server = await createMcpServer(config)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({name: 'test', version: '1.0.0'})
  await client.connect(clientTransport)
  return client
}

/** Builds a loadable command whose run() logs `output` and returns null. */
function cmdWithOutput(base: Command.Loadable, output: string): Command.Loadable {
  const loadable = {
    ...base,
    load: async () =>
      class MockCmd {
        log = (_msg?: string) => {
          // output is captured by the command runner, not printed
        }

        warn = String

        async run() {
          this.log(output)
          return null
        }
      },
  }
  return loadable as never
}

/** Builds a loadable command whose run() throws `message`. */
function cmdThatThrows(base: Command.Loadable, message: string): Command.Loadable {
  const loadable = {
    ...base,
    load: async () =>
      class ThrowCmd {
        log = () => {
          // output is discarded
        }

        warn = String

        async run(): Promise<undefined> {
          throw new Error(message)
        }
      },
  }
  return loadable as never
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('mcp-server', () => {
  describe('createMcpServer', () => {
    it('creates a server without throwing', async () => {
      const config = makeMockConfig(ALL_COMMANDS)
      const server = await createMcpServer(config)
      expect(server).to.exist
    })

    it('exposes exactly two tools: search_tools and run_command', async () => {
      const client = await makeClient(ALL_COMMANDS)
      const {tools} = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).to.have.members(['search_tools', 'run_command'])
    })
  })

  // ─── run_command handler ──────────────────────────────────────────────────

  describe('run_command tool handler', () => {
    it('returns isError for an unknown command', async () => {
      const client = await makeClient(ALL_COMMANDS)
      const result = (await client.callTool({
        arguments: {commandId: 'no such command'},
        name: 'run_command',
      })) as unknown as CallToolResult
      expect(result.isError).to.be.true
      const {text} = result.content[0]
      expect(text).to.include('Unknown command')
      expect(text).to.include('no such command')
    })

    it('resolves command by space-separated ID (display form)', async () => {
      const executable = cmdWithOutput(IMPORT_CMD, 'imported')
      const client = await makeClient([executable, SEARCH_CMD])
      // 'api import' is the display form of 'api:import'
      const result = (await client.callTool({
        arguments: {args: {source: './spec.json'}, commandId: 'api import'},
        name: 'run_command',
      })) as unknown as CallToolResult
      expect(result.isError).to.be.undefined
      const {text} = result.content[0]
      expect(text).to.include('imported')
    })

    it('resolves command by colon-separated ID (canonical form)', async () => {
      const executable = cmdWithOutput(IMPORT_CMD, 'imported-colon')
      const client = await makeClient([executable, SEARCH_CMD])
      // 'api:import' is the canonical id stored in the map
      const result = (await client.callTool({
        arguments: {args: {source: './spec.json'}, commandId: 'api:import'},
        name: 'run_command',
      })) as unknown as CallToolResult
      expect(result.isError).to.be.undefined
      const {text} = result.content[0]
      expect(text).to.include('imported-colon')
    })

    it('passes positional args and flags correctly to the command', async () => {
      const capturedArgv: string[] = []
      const capturing = {
        ...IMPORT_CMD,
        load: async () =>
          class CapturCmd {
            log = () => {
              // output is discarded
            }

            warn = String

            constructor(
              readonly argv: string[],
              _config: Config,
            ) {
              capturedArgv.push(...argv)
            }

            async run() {
              return null
            }
          },
      }
      const loadable = capturing as never as Command.Loadable
      const client = await makeClient([loadable, SEARCH_CMD])
      await client.callTool({
        arguments: {args: {name: 'my-api', source: './api.json'}, commandId: 'api import'},
        name: 'run_command',
      })
      expect(capturedArgv).to.deep.equal(['./api.json', '--name', 'my-api'])
    })

    it('returns isError and the error message when the command throws', async () => {
      const failing = cmdThatThrows(IMPORT_CMD, 'something went wrong')
      const client = await makeClient([failing, SEARCH_CMD])
      const result = (await client.callTool({
        arguments: {args: {source: './bad.json'}, commandId: 'api import'},
        name: 'run_command',
      })) as unknown as CallToolResult
      expect(result.isError).to.be.true
      const {text} = result.content[0]
      expect(text).to.include('something went wrong')
    })

    it('runs with no args when args field is omitted', async () => {
      const executable = cmdWithOutput(PETSTORE_CMD, 'all pets')
      const client = await makeClient([executable, SEARCH_CMD])
      const result = (await client.callTool({
        arguments: {commandId: 'petstore listPets'},
        name: 'run_command',
      })) as unknown as CallToolResult
      expect(result.isError).to.be.undefined
      const {text} = result.content[0]
      expect(text).to.include('all pets')
    })

    it('passes flags field to the command alongside args', async () => {
      const capturedArgv: string[] = []
      const capturing = {
        ...PETSTORE_CMD,
        load: async () =>
          class CaptureCmd {
            log = () => {
              // output is discarded
            }

            warn = String

            constructor(
              readonly argv: string[],
              _config: Config,
            ) {
              capturedArgv.push(...argv)
            }

            async run() {
              return null
            }
          },
      }
      const loadable = capturing as never as Command.Loadable
      const client = await makeClient([loadable, SEARCH_CMD])
      await client.callTool({
        arguments: {commandId: 'petstore listPets', flags: {limit: '10'}},
        name: 'run_command',
      })
      expect(capturedArgv).to.include('--limit').and.to.include('10')
    })
  })

  // ─── search_tools handler ─────────────────────────────────────────────────

  describe('search_tools tool handler', () => {
    it('returns results from the search command', async () => {
      const executable = cmdWithOutput(SEARCH_CMD, 'jira get issue')
      const client = await makeClient([executable])
      const result = (await client.callTool({
        arguments: {query: 'jira'},
        name: 'search_tools',
      })) as unknown as CallToolResult
      expect(result.isError).to.be.undefined
      const {text} = result.content[0]
      expect(text).to.include('jira get issue')
    })

    it('returns isError when no search command is registered', async () => {
      const client = await makeClient([IMPORT_CMD])
      const result = (await client.callTool({
        arguments: {query: 'anything'},
        name: 'search_tools',
      })) as unknown as CallToolResult
      expect(result.isError).to.be.true
    })

    it('forwards the limit argument to the search command', async () => {
      const capturedArgv: string[] = []
      const capturing = {
        ...SEARCH_CMD,
        load: async () =>
          class CaptureSearch {
            log = () => {
              // output is discarded
            }

            warn = String

            constructor(
              readonly argv: string[],
              _config: Config,
            ) {
              capturedArgv.push(...argv)
            }

            async run() {
              return null
            }
          },
      }
      const loadable = capturing as never as Command.Loadable
      const client = await makeClient([loadable])
      await client.callTool({arguments: {limit: 3, query: 'jira'}, name: 'search_tools'})
      expect(capturedArgv).to.include('--limit').and.to.include('3')
    })
  })
})
