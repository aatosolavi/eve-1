#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <output-directory>" >&2
  exit 1
fi

fixture_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$fixture_root/../../.." && pwd)"
output_root="$1"
registry_root="$output_root/registry"
publishers_root="$output_root/publishers"
tarballs_root="$output_root/tarballs"
npm_consumer_root="$output_root/pnpm-publish-npm-install"
pnpm_consumer_root="$output_root/npm-publish-pnpm-install"

if [ -e "$output_root" ]; then
  echo "Output directory already exists: $output_root" >&2
  exit 1
fi

mkdir -p "$registry_root" "$publishers_root" "$tarballs_root"
cp "$fixture_root/verdaccio.yaml" "$registry_root/config.yaml"

registry_port="$(
  node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
)"
registry_url="http://127.0.0.1:$registry_port"
"$repository_root/node_modules/.bin/verdaccio" \
  --config "$registry_root/config.yaml" \
  --listen "127.0.0.1:$registry_port" \
  >"$registry_root/verdaccio.log" 2>&1 &
registry_pid="$!"

stop_registry() {
  kill "$registry_pid" 2>/dev/null || true
  wait "$registry_pid" 2>/dev/null || true
}
trap stop_registry EXIT

registry_ready=false
for _ in {1..40}; do
  if curl --fail --silent "$registry_url/-/ping" >/dev/null; then
    registry_ready=true
    break
  fi
  if ! kill -0 "$registry_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if [ "$registry_ready" != true ]; then
  echo "Local package registry failed to start." >&2
  sed -n '1,200p' "$registry_root/verdaccio.log" >&2
  exit 1
fi

auth_token="$(
  node -e '
    void (async () => {
      const registryUrl = process.argv[1];
      const response = await fetch(`${registryUrl}/-/user/org.couchdb.user:eve-e2e`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "eve-e2e",
          password: "eve-e2e-password",
          email: "eve-e2e@example.com",
          type: "user",
          roles: [],
        }),
      });
      if (!response.ok) {
        throw new Error(`Registry authentication failed: ${response.status} ${await response.text()}`);
      }
      const body = await response.json();
      if (typeof body.token !== "string") {
        throw new Error("Registry authentication returned no token.");
      }
      process.stdout.write(body.token);
    })();
  ' "$registry_url"
)"
export NPM_CONFIG_USERCONFIG="$registry_root/npmrc"
npm config set "//${registry_url#http://}/:_authToken" "$auth_token"

# eve is not the package-manager interoperability subject, so both consumers
# install the same built eve tarball while the extensions cross the registry.
pnpm --dir "$repository_root/packages/eve" pack \
  --pack-destination "$tarballs_root" \
  --config.ignore-scripts=true >/dev/null

eve_tarballs=("$tarballs_root"/eve-*.tgz)
if [ "${#eve_tarballs[@]}" -ne 1 ]; then
  echo "Expected one packed eve tarball, found ${#eve_tarballs[@]}." >&2
  exit 1
fi
eve_tarball="${eve_tarballs[0]}"

prepare_publisher() {
  local package_name="$1"
  local publisher_root="$publishers_root/$package_name"
  local source_root="$repository_root/e2e/fixtures/$package_name"

  mkdir -p "$publisher_root"
  cp -R "$source_root/dist" "$publisher_root/"
  cp "$source_root/package.json" "$publisher_root/"
  (
    cd "$publisher_root"
    npm pkg delete private devDependencies
  )
}

prepare_consumer() {
  local consumer_root="$1"
  local extension_name="$2"
  local eval_name="$3"

  mkdir -p "$consumer_root/agent/extensions" "$consumer_root/evals"
  cp "$fixture_root/agent/agent.ts" "$fixture_root/agent/instructions.md" "$consumer_root/agent/"
  cp "$fixture_root/agent/extensions/$extension_name.ts" "$consumer_root/agent/extensions/"
  cp "$fixture_root/evals/evals.config.ts" "$fixture_root/evals/$eval_name.eval.ts" \
    "$consumer_root/evals/"
  cp "$fixture_root/package.json" "$fixture_root/tsconfig.json" "$fixture_root/.vercelignore" \
    "$consumer_root/"
  (
    cd "$consumer_root"
    npm pkg delete dependencies devDependencies
  )
}

assert_registry_install() {
  local consumer_root="$1"
  local package_name="$2"
  local package_root
  package_root="$(cd "$consumer_root/node_modules/$package_name" && pwd -P)"

  if [ ! -f "$package_root/dist/extension/_manifest.json" ]; then
    echo "Installed $package_name is missing its built extension manifest." >&2
    exit 1
  fi
  if [ -e "$package_root/extension" ]; then
    echo "Installed $package_name unexpectedly contains author source." >&2
    exit 1
  fi
  case "$package_root" in
    "$repository_root"/*)
      echo "Installed $package_name resolves back into the pnpm workspace." >&2
      exit 1
      ;;
  esac
}

prepare_publisher gadget-extension
prepare_publisher gizmo-extension

pnpm publish "$publishers_root/gadget-extension" \
  --registry "$registry_url" \
  --no-git-checks \
  --ignore-scripts
(
  cd "$publishers_root/gizmo-extension"
  npm publish \
    --registry "$registry_url" \
    --ignore-scripts
)

gadget_tarball_url="$(
  npm view \
    --registry "$registry_url" \
    "gadget-extension@0.0.0" \
    dist.tarball
)"
gizmo_tarball_url="$(
  pnpm view \
    --registry "$registry_url" \
    "gizmo-extension@0.0.0" \
    dist.tarball
)"

prepare_consumer "$npm_consumer_root" gadget gadget
(
  cd "$npm_consumer_root"
  npm install \
    --no-audit \
    --no-fund \
    --loglevel=error \
    "$eve_tarball" \
    "$gadget_tarball_url"
  npm ls --depth=0 eve gadget-extension
)
assert_registry_install "$npm_consumer_root" gadget-extension

prepare_consumer "$pnpm_consumer_root" gizmo gizmo
pnpm --dir "$pnpm_consumer_root" add \
  --config.minimum-release-age=0 \
  "$eve_tarball" \
  "$gizmo_tarball_url"
pnpm --dir "$pnpm_consumer_root" list --depth=0 eve gizmo-extension
assert_registry_install "$pnpm_consumer_root" gizmo-extension

echo "Published with pnpm and installed with npm: $npm_consumer_root"
echo "Published with npm and installed with pnpm: $pnpm_consumer_root"
