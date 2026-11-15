import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import manifest from '../runtimes/hermes/manifest.json' with { type: 'json' };

const script = fileURLToPath(new URL('../scripts/check-hermes-release.js', import.meta.url));
const pinned = manifest.upstream.tag;
const newer = `v${Number(pinned.replace(/^v/, '').split('.')[0]) + 1}.0.0`;

function runCheck(result) {
  const mockFetch = `
    import assert from 'node:assert/strict';
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(++calls, 1);
      assert.equal(url, 'https://api.github.com/repos/NousResearch/hermes-agent/releases/latest');
      assert.deepEqual(options.headers, { accept: 'application/vnd.github+json' });
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const result = ${JSON.stringify(result)};
      if (result.offline) throw new Error('synthetic private diagnostic');
      return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
    };
  `;
  const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mockFetch)}`, script], {
    env: {}, encoding: 'utf8', timeout: 10_000
  });
  assert.ifError(child.error);
  return child;
}

test('the private release check records stable release findings and never applies an update', () => {
  for (const [tag_name, expected] of [[pinned, /No newer stable/], [newer, /Compatibility review required/]]) {
    const result = runCheck({ body: { tag_name, draft: false, prerelease: false, body: 'synthetic untrusted release notes' } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, expected);
    assert.doesNotMatch(result.stdout, /synthetic untrusted release notes/);
    assert.equal(result.stderr, '');
  }
});

test('failed and repeated checks record only an operational error', () => {
  for (const failure of [{ status: 503 }, { offline: true }, { body: { tag_name: 'synthetic\nlog injection' } }, { offline: true }]) {
    const result = runCheck(failure);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^SOMA Hermes release check failed\./);
    assert.doesNotMatch(result.stderr, /synthetic|log injection/);
  }
});
