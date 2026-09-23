// Runs every script against every installed Zero version and prints a summary table.
// "BUG" = the script reproduced the bug, "ok" = it didn't.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const versions = [
	['@rocicorp/zero', '1.9.0 (npm latest)'],
	['zero-canary', '1.11.0-canary.11'],
	['zero-pr6636', '1.11 canary + open fix mono#6636'],
]
const scripts = ['bug1-dropped-add.mjs', 'bug2-out-of-sync-rows.mjs', 'fuzz.mjs']

console.log(['version'.padEnd(34), ...scripts.map((s) => s.padEnd(26))].join(''))
for (const [pkg, label] of versions) {
	if (!existsSync(new URL(`./node_modules/${pkg}/package.json`, import.meta.url))) {
		console.log(`${label.padEnd(34)}(not installed${pkg === 'zero-pr6636' ? ': run `npm run patch-pr6636`' : ''})`)
		continue
	}
	const cells = scripts.map((script) => {
		const { status } = spawnSync(process.execPath, [script], { env: { ...process.env, ZERO_PKG: pkg } })
		return (status === 0 ? 'ok' : 'BUG').padEnd(26)
	})
	console.log(label.padEnd(34) + cells.join(''))
}
