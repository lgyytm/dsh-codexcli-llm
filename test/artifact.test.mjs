import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('publishes one DSH bundle with a browser module', () => {
  assert.equal(packageJson.name, 'dsh-codex')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.match(patch, /id: llm-codex/)
  assert.match(patch, /name: dsh-codex/)
  assert.ok(existsSync(new URL('../lib/index.js', import.meta.url)))
  assert.ok(existsSync(new URL('../lib/invariant.js', import.meta.url)))
  assert.match(client, /window\.__ModuleLoader__\.load\(/)
  assert.doesNotMatch(client, /^import /m)
})
