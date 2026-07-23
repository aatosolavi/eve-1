#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <consumer-directory>" >&2
  exit 1
fi

fixture_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$fixture_root/../../.." && pwd)"
consumer_root="$1"
tarballs_root="$consumer_root/tarballs"

if [ -e "$consumer_root" ]; then
  echo "Consumer directory already exists: $consumer_root" >&2
  exit 1
fi

mkdir -p "$tarballs_root"
cp -R "$fixture_root/agent" "$fixture_root/evals" "$consumer_root/"
cp "$fixture_root/package.json" "$fixture_root/tsconfig.json" "$fixture_root/.vercelignore" \
  "$consumer_root/"

# pnpm publish uploads the same package artifact produced by pnpm pack. Skip
# lifecycle scripts because the e2e workflow has already built eve and each
# extension, and rebuilding shared output concurrently would make matrix jobs
# race with one another.
pnpm --dir "$repository_root/packages/eve" pack \
  --pack-destination "$tarballs_root" \
  --config.ignore-scripts=true >/dev/null
pnpm --dir "$repository_root/e2e/fixtures/gadget-extension" pack \
  --pack-destination "$tarballs_root" \
  --config.ignore-scripts=true >/dev/null
pnpm --dir "$repository_root/e2e/fixtures/gizmo-extension" pack \
  --pack-destination "$tarballs_root" \
  --config.ignore-scripts=true >/dev/null
echo "Packed eve and extension fixtures with pnpm."

tarballs=("$tarballs_root"/*.tgz)
if [ "${#tarballs[@]}" -ne 3 ]; then
  echo "Expected three pnpm-packed tarballs, found ${#tarballs[@]}." >&2
  exit 1
fi

(
  cd "$consumer_root"

  # Remove workspace-only dependency protocols before asking npm to create the
  # standalone consumer install. npm then records and installs only tarballs
  # with the same contents a registry consumer receives.
  npm pkg delete dependencies devDependencies
  npm install --no-audit --no-fund --loglevel=error "${tarballs[@]}"
  npm ls --depth=0 eve gadget-extension gizmo-extension

  for package_name in eve gadget-extension gizmo-extension; do
    if [ -L "node_modules/$package_name" ] || [ ! -d "node_modules/$package_name" ]; then
      echo "Expected npm to physically install $package_name from its tarball." >&2
      exit 1
    fi
  done
)
