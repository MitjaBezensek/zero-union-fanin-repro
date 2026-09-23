// BUG 1: a row that starts matching later never reaches the client
// ================================================================
//
// Fixed upstream in rocicorp/mono#6380 (1.11 canaries). Still broken in 1.9.0, which is
// the current npm `latest`.
//
// Story: post p1 exists and doesn't match yet. Then I like it, so it should show up.
//
// What happens inside Zero:
//   1. The `like` row goes into the flipped "likes" branch. That branch finds p1 and
//      emits "add p1".
//   2. UnionFanIn must not send p1 twice. If the bookmarks branch already has p1, the
//      client already has it too. So UnionFanIn asks the bookmarks branch: "do you
//      have p1?", and treats the first thing it gets back as the answer.
//   3. The bookmarks branch reads the p1 row from the post table to check it. On a
//      busy server, zero-cache's table source sends the marker 'yield' ("let me pause
//      for a moment") before that row.
//   4. UnionFanIn looks only at the first value (union-fan-in.js, `first(...) !== undefined`).
//      It sees 'yield', takes it as "yes, the bookmarks branch has p1", and drops the add.
//
// The client never gets p1 until the query is rebuilt (reload, reconnect, deploy).
// Because it depends on server load (the 10ms yield timer), it's flaky in real life.
// This script forces the timer to "always expired" so it fails every time.

import { startFakeZeroCache } from './fake-zero-cache.mjs'
import { expectSame, finish, title } from './report.mjs'
import { myLike, p1, postsILikedOrBookmarked, schema } from './schema.mjs'

for (const yields of [false, true]) {
	title(
		yields
			? "Busy server (table sources send 'yield' markers)"
			: "Idle server (no 'yield' markers), shown for comparison"
	)

	const server = startFakeZeroCache({
		schema,
		query: postsILikedOrBookmarked,
		rows: { post: [p1] }, // p1 exists, nobody liked or bookmarked it yet
		flip: ['likes'], // the planner flipped the "likes" EXISTS
		yields,
	})
	expectSame('before: client shows', server.clientResult(), [])

	server.write('like', 'add', myLike) // I like p1

	expectSame('after like: correct result', server.correctResult(), ['p1'])
	expectSame('after like: client shows', server.clientResult(), ['p1'])
}

finish()
