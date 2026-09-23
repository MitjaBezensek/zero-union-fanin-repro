// BUG 2: the client's copy of the rows drifts from the server
// ===========================================================
//
// Still broken in 1.9.0 and in the 1.11 canaries. Open fix: rocicorp/mono#6636.
// No 'yield' markers are needed for this one.
//
// Background: zero-cache doesn't send "query results" to the client. It sends rows, and
// counts, per query, how many times each row is needed (a reference count). That
// includes the rows that prove an EXISTS is true: for "posts I liked", the `like` row is
// sent too, because the client runs the query again locally and needs the proof. A row
// leaves the client when its count drops to 0.
//
// The count stays right only if every "+1" is matched by a "-1". UnionFanIn breaks that
// in two places:
//
//   A. Hydration (the first fetch). A post that matches through BOTH branches comes out
//      twice, once per branch, each copy carrying its own proof. UnionFanIn keeps the
//      first copy and throws the second away, proof included (mergeFetches in
//      union-fan-in.js). So only one proof row is sent. Later pushes merge both
//      branches' proofs (push-accumulated.js), so hydration and pushes disagree.
//
//   B. Pushes from the flipped branch. When that branch loses its last proof row for a
//      post and the other branch still has the post, UnionFanIn drops the "remove",
//      which is right for the post. But the removed proof row was inside that dropped
//      message, so its "-1" is never sent (#pushInternalChange in union-fan-in.js).
//
// Each scenario below is the shortest sequence we found for one visible symptom.
// Every scenario uses the same query, with only the "likes" EXISTS flipped.

import { startFakeZeroCache } from './fake-zero-cache.mjs'
import { expectSame, finish, title } from './report.mjs'
import { myBookmark, myLike, p1, postsILikedOrBookmarked, schema } from './schema.mjs'

const start = (rows) =>
	startFakeZeroCache({ schema, query: postsILikedOrBookmarked, rows, flip: ['likes'] })

// ---------------------------------------------------------------------------------------
title('Scenario 1: client hides a post that still matches (cause A)')
// p1 is liked AND bookmarked. Hydration sends p1 with only ONE proof (the bookmark,
// because the normal branch comes first), so the `like` row never reaches the client.
// Removing the bookmark is correct for the server (p1 still matches through the like),
// but the client now has p1 and no proof, so its local query drops p1.
{
	const server = start({ post: [p1], like: [myLike], bookmark: [myBookmark] })
	server.write('bookmark', 'remove', myBookmark)

	expectSame('correct result', server.correctResult(), ['p1'])
	expectSame('client shows', server.clientResult(), ['p1'])
}

// ---------------------------------------------------------------------------------------
title('Scenario 2: a deleted row stays on the client (cause B)')
// p1 is liked. Then I bookmark it (both proofs are sent, counts are fine). Then I unlike
// it: the flipped branch says "remove p1", UnionFanIn drops that because the bookmark
// still holds p1, and the like's "-1" goes with it. The deleted like stays on the client
// until the query is rebuilt. Every other query on the client that reads `like` sees it
// too.
{
	const server = start({ post: [p1], like: [myLike] })
	server.write('bookmark', 'add', myBookmark)
	server.write('like', 'remove', myLike)

	expectSame('correct result', server.correctResult(), ['p1'])
	expectSame('client shows', server.clientResult(), ['p1'])
	expectSame('deleted rows still on client', server.staleRowsOnClient(), [])
}

// ---------------------------------------------------------------------------------------
title('Scenario 3: a reference count goes negative (cause A)')
// p1 is liked AND bookmarked. Hydration counted only the bookmark (see scenario 1).
// Deleting the post sends ONE remove that carries BOTH proofs (pushes merge both
// branches), so the like drops to -1. When the post comes back, the like's "+1" only
// brings it to 0, so the client still lacks it. Remove the bookmark and the client
// hides p1 although it matches.
{
	const server = start({ post: [p1], like: [myLike], bookmark: [myBookmark] })
	server.write('post', 'remove', p1)
	expectSame('after deleting p1: negative refcounts', server.negativeRefCounts(), [])

	server.write('post', 'add', p1)
	server.write('bookmark', 'remove', myBookmark)
	expectSame('after restoring p1, unbookmarking: correct result', server.correctResult(), ['p1'])
	expectSame('after restoring p1, unbookmarking: client shows', server.clientResult(), ['p1'])
}

finish()
