// Tries every small case on the post/like/bookmark schema and lists every one that goes wrong.
// The bug scripts are hand-picked examples. This shows they're not flukes.
//
// Every combination of:
//   - which EXISTS the planner flipped: likes, bookmarks, or both
//   - which of the 3 rows (p1, my like, my bookmark) exist at the start
//   - every sequence of 1-3 writes, where each write adds or removes one of those rows
//   - with and without 'yield' markers
// After each case we compare the client with the truth (see fake-zero-cache.mjs).

import { startFakeZeroCache } from './fake-zero-cache.mjs'
import { myBookmark, myLike, p1, postsILikedOrBookmarked, schema } from './schema.mjs'

const rows = [
	['post', p1],
	['like', myLike],
	['bookmark', myBookmark],
]
const flipChoices = [['likes'], ['bookmarks'], ['likes', 'bookmarks']]

// every sequence of 1-3 row indexes, e.g. [0], [0, 2], [1, 1, 0]
const sequences = []
const grow = (seq) => {
	if (seq.length) sequences.push(seq)
	if (seq.length < 3) for (let i = 0; i < rows.length; i++) grow([...seq, i])
}
grow([])

const failures = new Map() // symptom -> shortest example
let cases = 0
for (const yields of [false, true])
	for (const flip of flipChoices)
		for (let startMask = 0; startMask < 1 << rows.length; startMask++)
			for (const sequence of sequences) {
				cases++
				const present = rows.map((_, i) => Boolean(startMask & (1 << i)))
				const start = {}
				rows.forEach(([table, row], i) => present[i] && (start[table] ??= []).push(row))

				const server = startFakeZeroCache({ schema, query: postsILikedOrBookmarked, rows: start, flip, yields })
				const steps = []
				for (const i of sequence) {
					const [table, row] = rows[i]
					server.write(table, present[i] ? 'remove' : 'add', row)
					steps.push(`${present[i] ? 'remove' : 'add'} ${table}`)
					present[i] = !present[i]
				}

				const symptoms = []
				const correct = server.correctResult()
				const client = server.clientResult()
				if (JSON.stringify(correct) !== JSON.stringify(client))
					symptoms.push(`client shows [${client}] instead of [${correct}]`)
				for (const key of server.staleRowsOnClient()) symptoms.push(`deleted ${key} stays on client`)
				for (const entry of server.negativeRefCounts()) symptoms.push(`refcount ${entry}`)

				for (const symptom of symptoms) {
					const key = `${yields ? 'yields' : 'no yields'} | flip ${flip.join('+')} | ${symptom}`
					const example = `start with [${rows.filter((_, i) => startMask & (1 << i)).map(([t]) => t)}], then ${steps.join(', ')}`
					if (!failures.has(key) || failures.get(key).length > example.length) failures.set(key, example)
				}
			}

for (const [key, example] of [...failures].sort()) console.log(`${key}\n    e.g. ${example}`)
console.log(`\n${cases} cases, ${failures.size} distinct failures`)
process.exit(failures.size ? 1 : 0)
