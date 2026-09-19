#!/usr/bin/env bash
# Runs the end-to-end suite twice: once through the built standalone CLI
# (stdio + Streamable HTTP), then again through the sdkck host CLI with this
# build packed and installed as its @hesed/mcp-server plugin — alongside the
# other @hesed plugins, so run_command can execute the imported plugins' real
# commands (modelled on the search plugin's host leg, search#45).
#
#   npm run test:e2e                            # everything, local plugin builds
#   E2E_PLUGINS="jira bb" npm run test:e2e      # a subset of extra plugins
#   E2E_PLUGIN_SOURCE=npm npm run test:e2e      # @hesed/<name>@latest from npm
#   npm run test:e2e -- --grep "jira plugin"    # extra args go to playwright
#   npm run test:e2e -- --keep                  # leave the throwaway home behind
#
# Credential-backed plugin reads (jira, conni, bb, sentry, trello) load their
# secrets from .env at the repo root when it exists and are skipped — with a
# warning — when it does not, so the suite stays green with no secrets (CI).
# mysql/psql run against throwaway Docker servers (fixtures vendored under
# test/e2e/docker/); those legs need Docker with the Compose plugin.
#
# Plugin sources (E2E_PLUGIN_SOURCE):
#   local (default) — build and npm pack the sibling repos (../jira, ../bb,
#     …; override the parent dir with E2E_PLUGIN_ROOT) and install the
#     tarballs: what a developer iterating across repos wants.
#   npm — install @hesed/<name>@latest straight from the registry: what CI
#     runs, proving the host against the published releases users get.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

ALL_PLUGINS="jira conni bb sentry trello mysql psql api2cli"
if [ -n "${E2E_PLUGINS:-}" ]; then
  SELECTED="$E2E_PLUGINS"
else
  SELECTED="$ALL_PLUGINS"
fi

E2E_PLUGIN_SOURCE="${E2E_PLUGIN_SOURCE:-local}"
if [ "$E2E_PLUGIN_SOURCE" != "local" ] && [ "$E2E_PLUGIN_SOURCE" != "npm" ]; then
  echo "error: E2E_PLUGIN_SOURCE must be 'local' or 'npm', got '$E2E_PLUGIN_SOURCE'" >&2
  exit 1
fi

E2E_PLUGIN_ROOT="${E2E_PLUGIN_ROOT:-$(cd "$REPO_ROOT/.." && pwd)}"

MYSQL_COMPOSE="$REPO_ROOT/test/e2e/docker/mysql/compose.yaml"
PSQL_COMPOSE="$REPO_ROOT/test/e2e/docker/psql/compose.yaml"

KEEP=0
PLAYWRIGHT_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) PLAYWRIGHT_ARGS+=("$arg") ;;
  esac
done

# ---------------------------------------------------------------------------
# Secrets — loaded for the credential-backed plugin reads; missing ones only
# skip their tests, they never fail the run.
# ---------------------------------------------------------------------------

if [ -f "$REPO_ROOT/.env" ]; then
  echo "==> Loading secrets from .env"
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

plugin_selected() {
  case " $SELECTED " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

required_env_for() {
  case "$1" in
    jira|conni) echo "ATLASSIAN_URL ATLASSIAN_EMAIL ATLASSIAN_API_TOKEN" ;;
    bb) echo "BITBUCKET_API_TOKEN BITBUCKET_EMAIL" ;;
    sentry) echo "SENTRY_API_KEY" ;;
    trello) echo "TRELLO_API_KEY TRELLO_SECRET" ;;
    *) echo "" ;;
  esac
}

for plugin in $SELECTED; do
  missing=""
  for var in $(required_env_for "$plugin"); do
    if [ -z "${!var:-}" ]; then
      missing="$missing $var"
    fi
  done
  if [ -n "$missing" ]; then
    echo "==> WARNING: $plugin tests will be skipped — missing secrets:$missing"
  fi
done

# ---------------------------------------------------------------------------
# Docker fixtures for the mysql/psql legs
# ---------------------------------------------------------------------------

MYSQL_STARTED=0
PSQL_STARTED=0
SDKCK_E2E_HOME=""
MCP_README_BAK=""

cleanup() {
  local status=$?

  # npm pack's prepack (`oclif readme`) rewrites the tracked README.md with
  # the current machine's usage string, so every README this run packed is
  # restored here — an e2e run must never dirty a worktree. Backups live in
  # the throwaway home under per-run names, so a run killed before its
  # restore leaves its recovery copy behind undisturbed.
  if [ -n "$SDKCK_E2E_HOME" ]; then
    if [ -f "$MCP_README_BAK" ]; then
      mv "$MCP_README_BAK" "$REPO_ROOT/README.md"
    fi

    if [ "$E2E_PLUGIN_SOURCE" = "local" ]; then
      local plugin
      for plugin in $ALL_PLUGINS; do
        if [ -f "$SDKCK_E2E_HOME/$plugin-README.md.bak" ]; then
          mv "$SDKCK_E2E_HOME/$plugin-README.md.bak" "$E2E_PLUGIN_ROOT/$plugin/README.md"
        fi
      done
    fi
  fi

  # --keep means keep: the containers stay up so a failed database-fixture
  # run can be inspected after the script exits.
  if [ "$KEEP" -eq 0 ]; then
    if [ "$MYSQL_STARTED" -eq 1 ]; then
      docker compose -f "$MYSQL_COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
    fi
    if [ "$PSQL_STARTED" -eq 1 ]; then
      docker compose -f "$PSQL_COMPOSE" down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  fi

  if [ "$KEEP" -ne 0 ]; then
    echo "==> Leaving the throwaway home and containers in place (--keep): $SDKCK_E2E_HOME"
    exit "$status"
  fi

  if [ -n "$SDKCK_E2E_HOME" ]; then
    rm -rf "$SDKCK_E2E_HOME"
  fi

  exit "$status"
}
trap cleanup EXIT

run_playwright() {
  # Delegates to the e2e:playwright script so both legs share one config.
  npm run --silent e2e:playwright -- ${PLAYWRIGHT_ARGS[@]+"${PLAYWRIGHT_ARGS[@]}"}
}

echo "==> Building the CLI"
npm run --silent build

echo "==> Leg 1: end-to-end tests through the standalone CLI"
run_playwright

# ---------------------------------------------------------------------------
# Host setup: the sdkck CLI, a throwaway home, and the plugin installs
# ---------------------------------------------------------------------------

# Deliberately NOT named SDKCK_HOME: an inherited SDKCK_HOME could point at
# the developer's real sdkck setup, and the EXIT trap must never rm -rf that.
SDKCK_E2E_HOME="$(mktemp -d)"

if [ -z "${E2E_SDKCK_BIN:-}" ]; then
  echo "==> Downloading the latest sdkck into the throwaway home"
  # --prefix keeps the install out of this repo's node_modules and lockfile:
  # an in-repo `npm install --no-save sdkck` was observed rewriting
  # package-lock.json on every run, which npm ci then rejects on CI.
  npm install --prefix "$SDKCK_E2E_HOME" --no-audit --no-fund --silent sdkck >/dev/null
  E2E_SDKCK_BIN="$SDKCK_E2E_HOME/node_modules/.bin/sdkck"
fi

start_mysql() {
  export MQ_E2E_PROJECT="${MQ_E2E_PROJECT:-mq-e2e-mcpserver-$$}"
  export MQ_E2E_PORT="${MQ_E2E_PORT:-0}"

  echo "==> Starting MySQL (project $MQ_E2E_PROJECT)"
  docker compose -f "$MYSQL_COMPOSE" up -d --build --wait >/dev/null
  # Flag before port discovery: if `compose up` succeeded but the lookup
  # below fails, the EXIT trap still owns the teardown (no leaked container).
  MYSQL_STARTED=1

  if [ "$MQ_E2E_PORT" = "0" ]; then
    MQ_E2E_PORT="$(docker compose -f "$MYSQL_COMPOSE" port mysql 3306 | sed 's/.*://')"
    export MQ_E2E_PORT
  fi

  echo "==> MySQL is listening on port $MQ_E2E_PORT"
}

start_psql() {
  export PG_E2E_PROJECT="${PG_E2E_PROJECT:-pg-e2e-mcpserver-$$}"
  export PG_E2E_PORT="${PG_E2E_PORT:-0}"

  echo "==> Starting PostgreSQL (project $PG_E2E_PROJECT)"
  docker compose -f "$PSQL_COMPOSE" up -d --build --wait >/dev/null
  # Same ownership rule as start_mysql: once the container is up, cleanup owns it.
  PSQL_STARTED=1

  if [ "$PG_E2E_PORT" = "0" ]; then
    PG_E2E_PORT="$(docker compose -f "$PSQL_COMPOSE" port postgres 5432 | sed 's/.*://')"
    export PG_E2E_PORT
  fi

  echo "==> PostgreSQL is listening on port $PG_E2E_PORT"
}

if plugin_selected mysql; then
  if docker compose version >/dev/null 2>&1; then
    start_mysql
  else
    echo "==> WARNING: docker compose unavailable — mysql tests will be skipped" >&2
  fi
fi
if plugin_selected psql; then
  if docker compose version >/dev/null 2>&1; then
    start_psql
  else
    echo "==> WARNING: docker compose unavailable — psql tests will be skipped" >&2
  fi
fi

install_plugin() {
  local spec="$1"
  local name="$2"

  echo "==> Installing $name into the throwaway home"
  # A tarball must be passed as a `file:` URL: sdkck resolves any bare path
  # containing a slash as a GitHub org/repo.
  SDKCK_CACHE_DIR="$SDKCK_E2E_HOME/cache" \
  SDKCK_CONFIG_DIR="$SDKCK_E2E_HOME/config" \
  SDKCK_DATA_DIR="$SDKCK_E2E_HOME/data" \
    "$E2E_SDKCK_BIN" plugins install "$spec" >/dev/null
}

# This build first, so the host's `mcp` commands come from the build under
# test, not the release sdkck bundles. Packing runs prepack, regenerating
# oclif.manifest.json and the README — the same artifacts the publish
# workflow ships — so the host leg exercises the real install artifact. The
# README backup goes into the throwaway home under a per-run name and is
# restored in the EXIT trap.
MCP_README_BAK="$SDKCK_E2E_HOME/mcp-server-README.md.bak"
cp "$REPO_ROOT/README.md" "$MCP_README_BAK"
echo "==> Packing the current build"
TGZ="$(npm pack --pack-destination "$SDKCK_E2E_HOME" | tail -n 1)"
install_plugin "file:$SDKCK_E2E_HOME/$TGZ" "@hesed/mcp-server (this build)"

# `oclif readme` inside each sibling's prepack rewrites its tracked
# README.md, so back it up and restore it right after packing — the backup
# lives in the throwaway home under a per-run name, never a fixed path.
pack_plugin() {
  local dir="$1"
  local name
  name="$(basename "$dir")"

  echo "==> Building and packing $name" >&2
  if [ ! -d "$dir/node_modules" ]; then
    (cd "$dir" && npm ci --silent >/dev/null 2>&1)
  fi

  (cd "$dir" && npm run --silent build >/dev/null 2>&1)

  local bak="$SDKCK_E2E_HOME/$name-README.md.bak"
  cp "$dir/README.md" "$bak"
  local tgz
  tgz="$(cd "$dir" && npm pack --pack-destination "$SDKCK_E2E_HOME" | tail -n 1)"
  mv "$bak" "$dir/README.md"

  echo "$SDKCK_E2E_HOME/$tgz"
}

for plugin in $SELECTED; do
  if [ "$E2E_PLUGIN_SOURCE" = "npm" ]; then
    install_plugin "@hesed/$plugin@latest" "@hesed/$plugin@latest"
    continue
  fi

  dir="$E2E_PLUGIN_ROOT/$plugin"
  if [ ! -d "$dir" ]; then
    echo "error: plugin repo not found: $dir (set E2E_PLUGIN_ROOT, or use E2E_PLUGIN_SOURCE=npm)" >&2
    exit 1
  fi

  tgz="$(pack_plugin "$dir")"
  install_plugin "file:$tgz" "@hesed/$plugin (local $dir)"
done

export E2E_SDKCK_HOME="$SDKCK_E2E_HOME"
export E2E_HOST_CLI="$E2E_SDKCK_BIN"
export E2E_SDKCK_PLUGINS="$SELECTED"

# A plugin subset selects the matching describe blocks (`e2e: <topic> plugin
# via sdkck`), plus the offline surface, which has no plugin dependencies.
# An explicit --grep from the caller wins. Leg 1 ignores the subset: the
# standalone host has no plugins at all.
if [ "$SELECTED" != "$ALL_PLUGINS" ]; then
  case "${PLAYWRIGHT_ARGS[*]:-}" in
    *--grep*) ;;
    *)
      labels=""
      for plugin in $SELECTED; do
        case "$plugin" in
          api2cli) topic="api" ;;
          *) topic="$plugin" ;;
        esac
        if [ -n "$labels" ]; then
          labels="$labels|$topic"
        else
          labels="$topic"
        fi
      done
      PLAYWRIGHT_ARGS+=(--grep "e2e: (offline|$labels) plugin via sdkck")
      ;;
  esac
fi

echo "==> Leg 2: end-to-end tests through the sdkck host CLI"
run_playwright
