// Tiny helpers so every script prints the same way.

import { zeroPackage } from './fake-zero-cache.mjs'

let bugsSeen = 0

export function title(text) {
	console.log(`\n${text}\n${'-'.repeat(text.length)}`)
}

/** Compare what happened with what should have happened, and print the result. */
export function expectSame(label, actual, expected) {
	const a = JSON.stringify(actual)
	const e = JSON.stringify(expected)
	if (a === e) {
		console.log(`  ok    ${label}: ${a}`)
	} else {
		bugsSeen++
		console.log(`  BUG   ${label}: got ${a}, expected ${e}`)
	}
}

/** Call at the end: exit code 1 means "the bug reproduced". */
export function finish() {
	const version = process.env.ZERO_PKG ?? '@rocicorp/zero (package.json)'
	console.log(
		bugsSeen
			? `\n=> ${bugsSeen} check(s) failed on ${version}: bug reproduced`
			: `\n=> all checks passed on ${version}: bug not present`
	)
	process.exit(bugsSeen ? 1 : 0)
}

export { zeroPackage }
