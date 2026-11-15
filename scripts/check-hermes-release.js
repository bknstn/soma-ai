import fs from 'node:fs';

const releaseUrl = 'https://api.github.com/repos/NousResearch/hermes-agent/releases/latest';

function stableVersion(tag) {
  const parts = typeof tag === 'string' && /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(tag);
  return parts ? parts.slice(1).map(Number) : null;
}

async function checkHermesRelease(pinnedTag) {
  const pinned = stableVersion(pinnedTag);
  if (!pinned) throw new Error('Invalid pinned Hermes release tag.');
  const response = await fetch(releaseUrl, {
    headers: { accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  }).catch(() => { throw new Error('Could not reach the public Hermes release endpoint.'); });
  if (!response.ok) throw new Error(`Hermes release lookup returned HTTP ${response.status}.`);
  const release = await response.json().catch(() => null);
  const latest = stableVersion(release?.tag_name);
  if (!latest || release.draft !== false || release.prerelease !== false) {
    throw new Error('Hermes release lookup returned an invalid stable release.');
  }
  const difference = latest.map((part, index) => part - pinned[index]).find((part) => part !== 0) ?? 0;
  return difference > 0
    ? `Hermes ${release.tag_name} is available (SOMA pins ${pinnedTag}). Compatibility review required.`
    : `No newer stable Hermes release found (SOMA pins ${pinnedTag}; upstream ${release.tag_name}).`;
}

try {
  const manifest = JSON.parse(fs.readFileSync(new URL('../runtimes/hermes/manifest.json', import.meta.url), 'utf8'));
  console.log(await checkHermesRelease(manifest.upstream?.tag));
} catch (error) {
  console.error(`SOMA Hermes release check failed. ${error.message}`);
  process.exitCode = 1;
}
