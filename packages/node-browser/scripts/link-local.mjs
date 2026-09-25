// Run after both cache hits and builds: node_modules belongs to pnpm and is not
// a build artifact, so Turbo must not restore it from another checkout.
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('../', import.meta.url))
const scope = resolve(pkg, 'node_modules/@bennyblader')
mkdirSync(scope, { recursive: true })
for (const triple of readdirSync(join(pkg, 'platform'))) {
  const link = join(scope, `ddk-${triple}`)
  rmSync(link, { recursive: true, force: true })
  symlinkSync(relative(dirname(link), join(pkg, 'platform', triple)), link, 'dir')
}
