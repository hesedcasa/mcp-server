import {expect} from 'chai'

import McpStart from '../../../src/commands/mcp/start.js'

describe('mcp start', () => {
  it('has the expected description', () => {
    expect(McpStart.description).to.include('MCP')
  })

  it('can be instantiated', () => {
    const stubConfig = {
      bin: 'sdkck',
      commands: [],
      runHook: async () => ({failures: [], successes: []}),
    }
    const cmd = new McpStart([], stubConfig as never)
    expect(cmd).to.be.instanceOf(McpStart)
  })
})
