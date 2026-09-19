import {expect} from '@playwright/test'
import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {loadE2eConfig, runCli} from './helpers.js'
import {expectToolSuccess, test} from './mcp.fixture.js'

/**
 * Host-leg plugin execution: the MCP server runs through the sdkck host
 * (E2E_HOST_CLI, set by scripts/e2e.sh) with every @hesed plugin installed
 * into a throwaway home, so run_command drives the imported plugins' real
 * commands — live sandbox reads for the credential-backed plugins, throwaway
 * Docker servers for mysql/psql, and a fully offline surface for the rest.
 *
 * Every describe is labelled "e2e: <topic> plugin via sdkck" so scripts/e2e.sh
 * can grep-select the ones matching E2E_PLUGINS. Standalone runs skip the
 * whole file: without the host there are no plugin commands to execute.
 */

/** True when every named environment variable is set (non-empty). */
function hasEnv(...names: string[]): boolean {
  return names.every((name) => (process.env[name] ?? '').length > 0)
}

function sdkckConfigDir(): string {
  const home = process.env.E2E_SDKCK_HOME
  if (!home) throw new Error('the plugin host leg requires E2E_SDKCK_HOME (run through scripts/e2e.sh)')
  return join(home, 'config')
}

async function writeProfile(configDir: string, file: string, profile: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(configDir, file),
    JSON.stringify({defaultProfile: 'default', profiles: {default: profile}}, null, 2),
    {mode: 0o600},
  )
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {headers: {authorization: `Bearer ${token}`}})
  return (await response.json()) as T
}

/**
 * Seeds each credential-backed plugin's auth profile into the sdkck config
 * dir (the same `<plugin>-config.json` shape the sdkck host suite uses).
 * Returns the first Sentry project slug when Sentry credentials resolve, so
 * the sentry test can target a real project.
 */
async function seedPluginAuth(configDir: string): Promise<string | undefined> {
  await mkdir(configDir, {recursive: true})

  if (hasEnv('ATLASSIAN_API_TOKEN', 'ATLASSIAN_EMAIL', 'ATLASSIAN_URL')) {
    const profile = {
      apiToken: process.env.ATLASSIAN_API_TOKEN!,
      email: process.env.ATLASSIAN_EMAIL!,
      host: process.env.ATLASSIAN_URL!,
    }
    await writeProfile(configDir, 'jira-config.json', profile)
    await writeProfile(configDir, 'conni-config.json', profile)
  }

  if (hasEnv('BITBUCKET_API_TOKEN', 'BITBUCKET_EMAIL')) {
    await writeProfile(configDir, 'bb-config.json', {
      apiToken: process.env.BITBUCKET_API_TOKEN!,
      email: process.env.BITBUCKET_EMAIL!,
    })
  }

  if (hasEnv('TRELLO_API_KEY', 'TRELLO_SECRET')) {
    await writeProfile(configDir, 'trello-config.json', {
      apiKey: process.env.TRELLO_API_KEY!,
      apiToken: process.env.TRELLO_SECRET!,
    })
  }

  const sentryRoot = (process.env.SENTRY_HOST ?? process.env.SENTRY_URL ?? '').replace(/\/+$/v, '')
  let sentryProject: string | undefined
  if (sentryRoot && hasEnv('SENTRY_API_KEY')) {
    // The plugin's host is the API root (…/api/0); resolve the org and a real
    // project slug so the read targets data the token can actually see.
    const orgs = await fetchJson<Array<{slug: string}>>(
      `${sentryRoot}/api/0/organizations/`,
      process.env.SENTRY_API_KEY!,
    )
    const organization = orgs[0]?.slug
    if (organization) {
      await writeProfile(configDir, 'sentry-config.json', {
        authToken: process.env.SENTRY_API_KEY!,
        host: `${sentryRoot}/api/0`,
        organization,
      })
      const projects = await fetchJson<Array<{slug: string}>>(
        `${sentryRoot}/api/0/organizations/${organization}/projects/`,
        process.env.SENTRY_API_KEY!,
      )
      sentryProject = projects[0]?.slug
    }
  }

  if (process.env.MQ_E2E_PORT) {
    await writeProfile(configDir, 'mysql-config.json', {
      database: 'mq_e2e',
      host: process.env.MQ_E2E_HOST ?? '127.0.0.1',
      maxConcurrentQueries: 5,
      password: 'mq_root_pw',
      port: Number(process.env.MQ_E2E_PORT),
      queryQueueTimeoutMs: 10_000,
      ssl: false,
      user: 'root',
    })
  }

  if (process.env.PG_E2E_PORT) {
    // The psql plugin names its config file after the standalone `pg` CLI it
    // grew out of, not the plugin.
    await writeProfile(configDir, 'pg-config.json', {
      database: 'pg_e2e',
      host: process.env.PG_E2E_HOST ?? '127.0.0.1',
      maxConcurrentQueries: 5,
      password: 'pg_e2e_pw',
      port: Number(process.env.PG_E2E_PORT),
      queryQueueTimeoutMs: 10_000,
      ssl: false,
      user: 'postgres',
    })
  }

  return sentryProject
}

test.describe('MCP host leg — imported plugin execution', () => {
  test.skip(!process.env.E2E_HOST_CLI, 'runs on the sdkck host leg only (scripts/e2e.sh)')

  let sentryProject: string | undefined

  test.beforeAll(async () => {
    sentryProject = await seedPluginAuth(sdkckConfigDir())
  })

  test.describe('e2e: offline plugin via sdkck', () => {
    test('search_tools finally takes its positive path over the real search command', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('search_tools', {query: 'issue'}))
      expect(text).toContain('jira')
    })

    test('search lists matching command ids across plugins', async ({mcp}) => {
      const text = expectToolSuccess(
        await mcp.callTool('run_command', {args: {query: 'list'}, commandId: 'search', flags: {limit: 20}}),
      )
      expect(text).toContain('bb repo list')
    })

    test('permission list reports the active rules', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'permission list'}))
      expect(text.trim()).not.toBe('')
    })

    test('commands enumerates the installed plugins', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'commands'}))
      expect(text).toContain('jira')
      expect(text).toContain('mysql')
    })

    test('api import → list → remove round-trips a local spec (offline)', async ({mcp}) => {
      const spec = join(loadE2eConfig().projectRoot, 'test/e2e/fixtures/petstore-e2e.yaml')
      const imported = expectToolSuccess(
        await mcp.callTool('run_command', {
          args: {source: spec},
          commandId: 'api import',
          flags: {name: 'e2e-petstore'},
        }),
      )
      expect(imported).toContain('e2e-petstore')

      const list = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'api list'}))
      expect(list).toContain('e2e-petstore')

      // `api remove` through the host's in-process runner exits the host
      // process mid-stdio-session (clean exit-0 — an upstream api2cli/host
      // interaction), so this last step runs the same plugin command through
      // the CLI surface instead.
      const removed = await runCli(loadE2eConfig(), sdkckConfigDir(), ['api:remove', 'e2e-petstore'])
      expect(removed).toContain('e2e-petstore')
    })
  })

  test.describe('e2e: jira plugin via sdkck', () => {
    test.skip(
      !hasEnv('ATLASSIAN_API_TOKEN', 'ATLASSIAN_EMAIL', 'ATLASSIAN_URL'),
      'requires Atlassian credentials in .env',
    )

    test('executes "jira project list" against the live sandbox', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'jira project list'}))
      expect(text).toContain('"data"')
    })

    test('executes "jira board" against the live sandbox', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'jira board'}))
      expect(text).toContain('"data"')
    })
  })

  test.describe('e2e: conni plugin via sdkck', () => {
    test.skip(
      !hasEnv('ATLASSIAN_API_TOKEN', 'ATLASSIAN_EMAIL', 'ATLASSIAN_URL'),
      'requires Atlassian credentials in .env',
    )

    test('executes "conni space list" against the live sandbox', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'conni space list'}))
      expect(text).toContain('"data"')
    })
  })

  test.describe('e2e: bb plugin via sdkck', () => {
    test.skip(!hasEnv('BITBUCKET_API_TOKEN', 'BITBUCKET_EMAIL'), 'requires Bitbucket credentials in .env')

    test('executes "bb workspace list" against the live sandbox', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'bb workspace list'}))
      expect(text).toContain('workspace_access')
    })
  })

  test.describe('e2e: sentry plugin via sdkck', () => {
    test.skip(
      !hasEnv('SENTRY_API_KEY') || !(process.env.SENTRY_HOST ?? process.env.SENTRY_URL),
      'requires Sentry credentials in .env',
    )

    test('executes "sentry project issues" against the live sandbox', async ({mcp}) => {
      test.skip(!sentryProject, 'no Sentry organization/project resolvable for this token')
      const text = expectToolSuccess(
        await mcp.callTool('run_command', {args: {projectSlug: sentryProject}, commandId: 'sentry project issues'}),
      )
      expect(text).toContain('"success": true')
    })
  })

  test.describe('e2e: trello plugin via sdkck', () => {
    test.skip(!hasEnv('TRELLO_API_KEY', 'TRELLO_SECRET'), 'requires Trello credentials in .env')

    test('executes "trello board list" against the live sandbox', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'trello board list'}))
      expect(text).toContain('"data"')
    })
  })

  test.describe('e2e: mysql plugin via sdkck', () => {
    test.skip(!process.env.MQ_E2E_PORT, 'requires the MySQL docker fixture (scripts/e2e.sh starts it)')

    test('executes "mysql tables" against the throwaway server', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'mysql tables'}))
      expect(text).toContain('users')
    })
  })

  test.describe('e2e: psql plugin via sdkck', () => {
    test.skip(!process.env.PG_E2E_PORT, 'requires the PostgreSQL docker fixture (scripts/e2e.sh starts it)')

    test('executes "psql databases" against the throwaway server', async ({mcp}) => {
      const text = expectToolSuccess(await mcp.callTool('run_command', {commandId: 'psql databases'}))
      expect(text).toContain('pg_e2e')
    })
  })
})
