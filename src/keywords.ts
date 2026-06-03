import type {Config} from '@oclif/core/interfaces'

import {isCommandAllowed} from '@hesed/permission'

type PermissionConfig = Parameters<typeof isCommandAllowed>[1]

const STOPWORDS = new Set([
  'a',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'belong',
  'bin',
  'by',
  'can',
  'current',
  'different',
  'display',
  'displays',
  'for',
  'from',
  'get',
  'has',
  'have',
  'hello',
  'in',
  'into',
  'is',
  'it',
  'its',
  'level',
  'new',
  'of',
  'on',
  'or',
  'over',
  'performed',
  'performs',
  'run',
  'set',
  'show',
  'specific',
  'that',
  'the',
  'their',
  'this',
  'to',
  'use',
  'used',
  'useful',
  'uses',
  'using',
  'will',
  'with',
  'work',
  'you',
])

export function buildKeywords(
  config: Config,
  permissionConfig: PermissionConfig,
  jitPlugins: Record<string, string>,
): Set<string> {
  const keywords = new Set<string>()

  const addWord = (raw: string) => {
    const word = raw.toLowerCase().replaceAll(/^-+|-+$/g, '')
    if (word.length >= 2 && !STOPWORDS.has(word)) keywords.add(word)
  }

  for (const c of config.commands) {
    const commandId = c.id.replaceAll(':', ' ')
    if (!isCommandAllowed(commandId, permissionConfig)) continue
    for (const part of c.id.split(':')) addWord(part)
    const text = `${c.summary ?? ''} ${c.description ?? ''}`
    for (const raw of text.split(/[^a-zA-Z0-9-]+/)) addWord(raw)
  }

  for (const name of Object.keys(jitPlugins)) {
    const short = name.split('/').pop()
    if (short) addWord(short)
  }

  return keywords
}
