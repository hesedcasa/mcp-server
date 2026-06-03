# mcp-server

MCP server plugin — exposes all CLI commands as MCP tools

[![Version](https://img.shields.io/npm/v/@hesed/mcp-server.svg)](https://npmjs.org/package/@hesed/mcp-server)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/hesedcasa/@hesed/mcp-server/blob/main/LICENSE)
[![Downloads/week](https://img.shields.io/npm/dw/@hesed/mcp-server.svg)](https://npmjs.org/package/@hesed/mcp-server)

<!-- toc -->
* [mcp-server](#mcp-server)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# Usage

<!-- usage -->
```sh-session
$ npm install -g @hesed/mcp-server
$ mcp-server COMMAND
running command...
$ mcp-server (--version)
@hesed/mcp-server/0.1.1 linux-x64 node-v22.22.3
$ mcp-server --help [COMMAND]
USAGE
  $ mcp-server COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`mcp-server mcp:start`](#mcp-server-mcpstart)
* [`mcp-server mcp:token:delete`](#mcp-server-mcptokendelete)
* [`mcp-server mcp:token:generate`](#mcp-server-mcptokengenerate)
* [`mcp-server mcp:token:show`](#mcp-server-mcptokenshow)

## `mcp-server mcp:start`

Start an MCP server exposing all CLI commands as tools

```
USAGE
  $ mcp-server mcp:start [--host <value>] [--port <value>] [--transport stdio|http]

FLAGS
  --host=<value>        [default: 127.0.0.1] IP address to listen on (HTTP transport only)
  --port=<value>        [default: 3000] Port to listen on (HTTP transport only)
  --transport=<option>  [default: stdio] Transport to use
                        <options: stdio|http>

DESCRIPTION
  Start an MCP server exposing all CLI commands as tools

EXAMPLES
  $ mcp-server mcp start

  $ mcp-server mcp start --transport http

  $ mcp-server mcp start --transport http --port 3001

  $ mcp-server mcp start --transport http --host 0.0.0.0
```

_See code: [src/commands/mcp/start.ts](https://github.com/hesedcasa/mcp-server/blob/v0.1.1/src/commands/mcp/start.ts)_

## `mcp-server mcp:token:delete`

Remove the MCP server Bearer token, disabling HTTP authentication

```
USAGE
  $ mcp-server mcp:token:delete

DESCRIPTION
  Remove the MCP server Bearer token, disabling HTTP authentication

EXAMPLES
  $ mcp-server mcp token delete
```

_See code: [src/commands/mcp/token/delete.ts](https://github.com/hesedcasa/mcp-server/blob/v0.1.1/src/commands/mcp/token/delete.ts)_

## `mcp-server mcp:token:generate`

Generate a Bearer token for MCP server HTTP authentication

```
USAGE
  $ mcp-server mcp:token:generate

DESCRIPTION
  Generate a Bearer token for MCP server HTTP authentication

EXAMPLES
  $ mcp-server mcp token generate
```

_See code: [src/commands/mcp/token/generate.ts](https://github.com/hesedcasa/mcp-server/blob/v0.1.1/src/commands/mcp/token/generate.ts)_

## `mcp-server mcp:token:show`

Show the current MCP server Bearer token

```
USAGE
  $ mcp-server mcp:token:show

DESCRIPTION
  Show the current MCP server Bearer token

EXAMPLES
  $ mcp-server mcp token show
```

_See code: [src/commands/mcp/token/show.ts](https://github.com/hesedcasa/mcp-server/blob/v0.1.1/src/commands/mcp/token/show.ts)_
<!-- commandsstop -->
