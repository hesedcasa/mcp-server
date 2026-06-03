import type {Config} from '@oclif/core/interfaces'

import {ExecutionError, runCommand} from './command-runner.js'

type ToolResult = {content: [{text: string; type: 'text'}]; isError?: true}
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>

export function makeRunCommandHandler(config: Config): ToolHandler {
  return async (args) => {
    const {
      args: cmdArgs = {},
      commandId = '',
      flags: cmdFlags = {},
    } = args as {
      args?: Record<string, unknown>
      commandId: string
      flags?: Record<string, unknown>
    }

    try {
      const result = await runCommand(config, commandId, {...cmdArgs, ...cmdFlags})
      return {
        content: [
          {
            text: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
            type: 'text' as const,
          },
        ],
        ...(result.error ? {isError: true as const} : {}),
      }
    } catch (error) {
      const msg =
        error instanceof ExecutionError
          ? error.code === 'command_not_found'
            ? `Unknown command: "${commandId}". Use the "search_tools" tool to find available commands.`
            : error.message
          : error instanceof Error
            ? error.message
            : String(error)
      return {content: [{text: msg, type: 'text' as const}], isError: true}
    }
  }
}

export function makeSearchToolsHandler(config: Config): ToolHandler {
  const searchCmd = config.commands.find((c) => c.id === 'search')
  return async (args) => {
    if (!searchCmd) {
      return {content: [{text: 'Search command not available', type: 'text' as const}], isError: true}
    }

    const query = (args.query as string) ?? ''
    const limit = args.limit as number | undefined

    const searchArgs: Record<string, unknown> = {query}
    if (limit !== undefined) searchArgs.limit = limit

    const {error, output} = await runCommand(config, 'search', searchArgs)
    if (error) {
      return {content: [{text: error, type: 'text' as const}], isError: true}
    }

    return {content: [{text: output, type: 'text' as const}]}
  }
}
