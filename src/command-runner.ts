import type {Command} from '@oclif/core'
import type {Config} from '@oclif/core/interfaces'

import {isCommandAllowed, readPermissionConfig} from '@hesed/permission'

export type ExecutionDenialCode = 'command_not_found' | 'permission_denied'

export class ExecutionError extends Error {
  code: ExecutionDenialCode
  commandId: string

  constructor(code: ExecutionDenialCode, commandId: string, message: string) {
    super(message)
    this.name = 'ExecutionError'
    this.code = code
    this.commandId = commandId
  }
}

export interface RunCommandResult {
  error?: string
  output: string
}

function appendFlagArgs(argv: string[], name: string, flag: {type: string}, value: unknown): void {
  if (flag.type === 'boolean') {
    if (value === true) argv.push(`--${name}`)
  } else if (Array.isArray(value)) {
    for (const v of value) argv.push(`--${name}`, String(v))
  } else {
    argv.push(`--${name}`, String(value))
  }
}

export function buildArgv(loadable: Command.Loadable, args: Record<string, unknown>): string[] {
  const argv: string[] = []

  for (const name of Object.keys(loadable.args ?? {})) {
    const value = args[name]
    if (value !== null && value !== undefined) argv.push(String(value))
  }

  for (const [name, flag] of Object.entries(loadable.flags ?? {})) {
    if (name === 'json') continue
    const value = args[name]
    if (value === null || value === undefined) continue
    appendFlagArgs(argv, name, flag as {type: string}, value)
  }

  return argv
}

function interceptOutput(instance: Command): () => string {
  const lines: string[] = []

  instance.log = (msg = '') => {
    lines.push(String(msg))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(instance as any).logJson = (json: unknown) => {
    lines.push(JSON.stringify(json, null, 2))
  }

  instance.warn = (msg: Error | string) => {
    lines.push(`Warning: ${String(msg)}`)
    return String(msg)
  }

  return () => lines.join('\n')
}

export async function executeCommand(
  loadable: Command.Loadable,
  argv: string[],
  config: Config,
): Promise<RunCommandResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = new ((await loadable.load()) as any)(argv, config) as Command
    const getOutput = interceptOutput(instance)
    const result = await instance.run()
    const output = result === null || result === undefined ? getOutput() : JSON.stringify(result, null, 2)
    return {output: output || '(no output)'}
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error), output: ''}
  }
}

export async function runCommand(
  config: Config,
  id: string,
  args: Record<string, unknown> = {},
): Promise<RunCommandResult> {
  const colonId = id.replaceAll(' ', ':')
  const loadable = config.commands.find((c) => c.id === colonId)
  if (!loadable) {
    throw new ExecutionError('command_not_found', id, `Command "${id}" not found.`)
  }

  const permissionConfig = await readPermissionConfig(config.configDir)
  const separator = config.topicSeparator ?? ' '
  const normalizedForPermission = loadable.id.replaceAll(':', separator)
  if (!isCommandAllowed(normalizedForPermission, permissionConfig)) {
    throw new ExecutionError(
      'permission_denied',
      loadable.id,
      `Command "${normalizedForPermission}" is blocked by the permission list.`,
    )
  }

  const argv = buildArgv(loadable, args)
  return executeCommand(loadable, argv, config)
}
