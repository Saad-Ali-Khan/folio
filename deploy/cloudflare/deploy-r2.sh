#!/usr/bin/env bash
set -euo pipefail
# The prepared launcher is copied alongside the release archive in .folio-cloudflare.
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$source_dir"
sha256sum --check release-r2-20261123.sha256
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
  set -u
fi
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]; then
  echo 'Use Node 24 in Ubuntu before running this release.' >&2
  exit 1
fi
mkdir -p "$HOME/folio-cloud-build"
release_dir="$(mktemp -d "$HOME/folio-cloud-build/release-r2-20261123-XXXXXX")"
tar -xzf "$source_dir/release-r2-20261123.tar.gz" -C "$release_dir"
cd "$release_dir"
node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync('release-source-manifest.json','utf8'));
for(const [file,expected] of Object.entries(manifest.files)) {
  if(createHash('sha256').update(readFileSync(file)).digest('hex')!==expected)throw Error('Source checksum failed: '+file);
}
console.log('PASS source snapshot checksums; base commit '+manifest.baseCommit);
console.log(manifest.source);
NODE
echo "Linux release folder: $release_dir"
npm ci --include=dev --no-audit --no-fund
npx wrangler whoami
npm run deploy:cloudflare 2>&1 | tee "$release_dir/deploy.log"
npm run monitor:production
node scripts/verify-photo-release.mjs photo-release-checks.json
echo 'PASS production R2 serving and original photo checksums. Neon originals retained.'
echo 'Local R2 import activation and a new Discord photo test remain after this deployment.'
echo "Deployment log: $release_dir/deploy.log"
