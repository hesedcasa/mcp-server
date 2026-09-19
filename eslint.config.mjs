import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

const config = [
  includeIgnoreFile(gitignorePath),
  {
    // Declarative Playwright config: the root tsconfig only builds ./src, and
    // routing the file through the project service's default project proved
    // flaky across runner platforms (the macos matrix jobs could not resolve
    // it at all) — so it sits outside typed linting entirely.
    ignores: ['playwright.config.ts'],
  },
  ...oclif,
  prettier,
  {
    rules: {
      // eslint-config-oclif keys this rule on 'node:path', but eslint-plugin-unicorn strips the
      // 'node:' protocol before looking the style up, so the config's intent (allow named imports
      // from node:path) never takes effect. Re-declare it under the stripped name.
      'unicorn/import-style': ['error', {styles: {path: {named: true}}}],
    },
  },
  {
    files: ['test/e2e/**/*.ts'],
    rules: {
      // The e2e suite probes the HTTP transport with global fetch. The rule keys
      // off the declared engines floor (>=20.17), where fetch is still flagged
      // experimental, but the suite only runs on Node >= 22 (CI) in practice.
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
]

export default config
