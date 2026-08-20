import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import { REPO_ROOT } from '../src/config.js'
import { ddk } from '../src/ddk.js'
import { runDdkReplay, type CompatVectors } from '../src/replay.js'

/**
 * Guards the committed compat vectors: the exact transcript ddk-rn replays on
 * device (example/src/compatVectors.ts) must still be what the current Rust
 * core produces. If this fails after an intentional core change, regenerate
 * with `pnpm vectors` — that reruns every @node-dlc cross-check and rewrites
 * both vector files, keeping the on-device suite in step.
 */
describe('committed compat vectors', () => {
  const vectors: CompatVectors = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'compat', 'vectors', 'compat-vectors.json'), 'utf8'),
  )

  test('the current ddk core reproduces every committed artifact', () => {
    const produced = runDdkReplay(ddk, vectors)
    expect(Object.keys(produced).sort()).toEqual(Object.keys(vectors.expected).sort())
    for (const [key, value] of Object.entries(vectors.expected)) {
      expect(produced[key], key).toBe(value)
    }
  })

  test('the ddk-rn copy of the vectors is in sync', () => {
    const rnModule = readFileSync(resolve(REPO_ROOT, 'ddk-rn', 'example', 'src', 'compatVectors.ts'), 'utf8')
    const json = JSON.stringify(vectors, null, 2)
    expect(rnModule.includes(json)).toBe(true)
  })

  test('the ddk-rn copy of the replay is in sync', () => {
    const replaySource = readFileSync(resolve(REPO_ROOT, 'compat', 'src', 'replay.ts'), 'utf8')
    const rnCopy = readFileSync(resolve(REPO_ROOT, 'ddk-rn', 'example', 'src', 'compatReplay.ts'), 'utf8')
    expect(rnCopy.endsWith(replaySource)).toBe(true)
  })
})
