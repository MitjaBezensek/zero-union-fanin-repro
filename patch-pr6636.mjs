// Builds node_modules/zero-pr6636: a copy of the 1.11 canary with the two files changed
// by the open fix rocicorp/mono#6636 swapped in. It lets you check whether that PR fixes
// the repros:
//
//   node patch-pr6636.mjs
//   ZERO_PKG=zero-pr6636 node bug2-out-of-sync-rows.mjs
//
// The PR's files are TypeScript. Node's built-in type stripping turns them into
// JavaScript, so no build tool is needed (Node 22.13 or newer).

import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const commit = 'ba22a48303a8d45c91f351a398a6d7b04bfa118e' // PR head when this repro was written
const from = new URL('./node_modules/zero-canary/', import.meta.url)
const to = new URL('./node_modules/zero-pr6636/', import.meta.url)
const ivm = new URL('out/zql/src/ivm/', to)

rmSync(to, { recursive: true, force: true })
cpSync(from, to, { recursive: true })

// The last two are small enum files: the published build inlines them as numbers, but the
// PR's files import them at runtime.
for (const file of ['union-fan-in', 'push-accumulated', 'change-type-enum', 'change-index-enum']) {
	const url = `https://raw.githubusercontent.com/rocicorp/mono/${commit}/packages/zql/src/ivm/${file}.ts`
	const response = await fetch(url)
	if (!response.ok) throw new Error(`download failed: ${url} (${response.status})`)
	const js = stripTypeScriptTypes(await response.text())
		// the published build imports ".js" files
		.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2')
	writeFileSync(new URL(`${file}.js`, ivm), js)
	console.log(`patched ${file}.js from ${url}`)
}

writeFileSync(
	new URL('change-type.js', ivm),
	"import * as ChangeType from './change-type-enum.js';\nexport { ChangeType };\n"
)
writeFileSync(
	new URL('change-index.js', ivm),
	"import * as ChangeIndex from './change-index-enum.js';\nexport { ChangeIndex };\n"
)
console.log('done: run with ZERO_PKG=zero-pr6636')
