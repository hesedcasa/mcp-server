import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

const config = [
  includeIgnoreFile(gitignorePath),
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
]

export default config
