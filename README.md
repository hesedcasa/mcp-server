# mcp-server

MCP server plugin — exposes all CLI commands as MCP tools

[![Version](https://img.shields.io/npm/v/@hesed/mcp-server.svg)](https://npmjs.org/package/@hesed/mcp-server)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/hesedcasa/@hesed/mcp-server/blob/main/LICENSE)
[![Downloads/week](https://img.shields.io/npm/dw/@hesed/mcp-server.svg)](https://npmjs.org/package/@hesed/mcp-server)

<!-- toc -->
* [permission](#permission)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# Usage

<!-- usage -->
```sh-session
$ npm install -g @hesed/permission
$ permission COMMAND
running command...
$ permission (--version)
@hesed/permission/0.1.1 linux-x64 node-v22.22.3
$ permission --help [COMMAND]
USAGE
  $ permission COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`permission permission disallow PATTERN`](#permission-permission-disallow-pattern)
* [`permission permission export FILE`](#permission-permission-export-file)
* [`permission permission import FILE`](#permission-permission-import-file)
* [`permission permission list`](#permission-permission-list)
* [`permission permission reset`](#permission-permission-reset)

## `permission permission disallow PATTERN`

Disallow a command pattern in the permission list

```
USAGE
  $ permission permission disallow PATTERN

ARGUMENTS
  PATTERN  Command pattern to disallow.

DESCRIPTION
  Disallow a command pattern in the permission list

EXAMPLES
  $ permission permission disallow "*"

  $ permission permission disallow jira

  $ permission permission disallow "jira *"

  $ permission permission disallow "jira issue create"
```

_See code: [src/commands/permission/disallow.ts](https://github.com/hesedcasa/permission/blob/v0.1.1/src/commands/permission/disallow.ts)_

## `permission permission export FILE`

Export the permission configuration to a JSON file

```
USAGE
  $ permission permission export FILE

ARGUMENTS
  FILE  File path to export the permission configuration to

DESCRIPTION
  Export the permission configuration to a JSON file

EXAMPLES
  $ permission permission export permission.json
```

_See code: [src/commands/permission/export.ts](https://github.com/hesedcasa/permission/blob/v0.1.1/src/commands/permission/export.ts)_

## `permission permission import FILE`

Import the permission configuration from a JSON file

```
USAGE
  $ permission permission import FILE

ARGUMENTS
  FILE  File path to import the permission configuration from

DESCRIPTION
  Import the permission configuration from a JSON file

EXAMPLES
  $ permission permission import permission.json
```

_See code: [src/commands/permission/import.ts](https://github.com/hesedcasa/permission/blob/v0.1.1/src/commands/permission/import.ts)_

## `permission permission list`

List all rules in the permission list

```
USAGE
  $ permission permission list

DESCRIPTION
  List all rules in the permission list

EXAMPLES
  $ permission permission list
```

_See code: [src/commands/permission/list.ts](https://github.com/hesedcasa/permission/blob/v0.1.1/src/commands/permission/list.ts)_

## `permission permission reset`

Reset all permission rules

```
USAGE
  $ permission permission reset [--confirm]

FLAGS
  --confirm  Skip the confirmation prompt

DESCRIPTION
  Reset all permission rules

EXAMPLES
  $ permission permission reset

  $ permission permission reset --confirm
```

_See code: [src/commands/permission/reset.ts](https://github.com/hesedcasa/permission/blob/v0.1.1/src/commands/permission/reset.ts)_
<!-- commandsstop -->
