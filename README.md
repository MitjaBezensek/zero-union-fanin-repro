# Zero `UnionFanIn` bugs: standalone repro

Two bugs in `@rocicorp/zero`: they make the client show the wrong rows for queries shaped like `where(or(exists(...), exists(...)))`. You need no database, no zero-cache, and no browser. The scripts drive Zero's own query engine directly.

## Upstream status

| Bug | 1.9.0 (npm `latest`) | 1.11 canaries | Upstream fix |
|---|---|---|---|
| 1. A row that starts matching late never reaches the client | broken | fixed | [rocicorp/mono#6380](https://github.com/rocicorp/mono/pull/6380), merged 2026-08-20 |
| 2. The client's copy of rows drifts: a matching row gets hidden, a deleted row stays, refcounts go negative | broken | broken | [rocicorp/mono#6636](https://github.com/rocicorp/mono/pull/6636), **open** (opened 2026-09-22) |

Both fixes are confirmed by this repo: `npm start` runs every script against all three builds. `npm run patch-pr6636` builds the third one: the canary with #6636's two changed files swapped in.

```
version                           bug1-dropped-add.mjs      bug2-out-of-sync-rows.mjs fuzz.mjs
1.9.0 (npm latest)                BUG                       BUG                       BUG
1.11.0-canary.11                  ok                        BUG                       BUG
1.11 canary + open fix mono#6636  ok                        ok                        ok
```

## Run it

```sh
npm install
npm run patch-pr6636   # optional: builds the "canary + #6636" copy (downloads 4 files from GitHub)
npm start              # the table above
npm run bug1           # read the output, then read the script
npm run bug2
npm run fuzz           # every small case, lists every failure
```

Node 22.13 or newer. Pick a version for a single script with `ZERO_PKG=zero-canary npm run bug2` (or `zero-pr6636`).

## Background you need (5 minutes)

**The query.** "Posts I liked or bookmarked" (`schema.mjs`):

```js
zql.post.where(({ or, exists }) =>
  or(
    exists('likes', (l) => l.where('userId', '=', 'me')),
    exists('bookmarks', (b) => b.where('userId', '=', 'me'))
  )
)
```

**Flipping.** Zero's query planner can "flip" an EXISTS. It then stops checking every post for a like by me: it starts from my (few) likes and looks up their posts. When a branch of an `or(...)` is flipped, Zero builds this pipeline:

```
                   post table
                       |
                  UnionFanOut          sends each post change down both branches
                  /         \
     EXISTS likes             EXISTS bookmarks
     (flipped)                (normal)
                  \         /
                  UnionFanIn           merges branches, removes duplicates
                       |
                  sent to client
```

Both bugs are in `UnionFanIn` (`zql/src/ivm/union-fan-in.js`).

**How rows reach the client.** zero-cache doesn't send "query results". It sends rows, and keeps a reference count per row per query. That includes the rows that *prove* an EXISTS: for "posts I liked", the `like` row is sent too. The client runs the query again locally over the rows it has, so it needs the proof. A row leaves the client when its count reaches 0. If a "+1" is ever missing, or a "-1" is lost, the client's rows drift.

**`'yield'`.** zero-cache runs many queries on one thread. Its SQLite table source sends the string `'yield'` ("I'm pausing for a moment") before a row when the current work has run longer than `ZERO_YIELD_THRESHOLD_MS` (default 10ms). Operators must pass it along and never treat it as a row.

## Bug 1: dropped add (`bug1-dropped-add.mjs`)

Post `p1` exists and matches nothing. I like it. It should appear.

1. The flipped "likes" branch emits "add p1".
2. `UnionFanIn` asks the other branch "do you already have p1?" (if so, the client has it already), and looks only at the **first value** it gets back: `first(input.fetch(...)) !== undefined`.
3. The bookmarks branch reads the p1 row to check it. On a busy server, `'yield'` comes first.
4. `'yield'` is not `undefined`, so `UnionFanIn` concludes "the other branch has it" and **drops the add**.

The client doesn't see p1 until the query is rebuilt (reload, reconnect, deploy). It depends on the 10ms timer, so in production it's flaky and load-dependent. The script forces the timer to "always expired". **Fixed by [mono#6380](https://github.com/rocicorp/mono/pull/6380)**: the probe now skips `'yield'` values and passes them along.

## Bug 2: client rows drift (`bug2-out-of-sync-rows.mjs`)

No `'yield'` needed, and a single flipped branch is enough. Two causes:

- **A. Hydration keeps one branch's proofs.** A post that matches through both branches comes out twice. `mergeFetches` keeps the first copy and throws the second away, proof rows included. Pushes later merge *both* branches' proofs (`push-accumulated.js`), so hydration and pushes count different rows.
- **B. A dropped remove takes its proof with it.** When the flipped branch loses its last proof for a post that the other branch still holds, `UnionFanIn` drops the "remove p1" (right for p1). But the removed proof row was inside that message, so its "-1" is never sent.

| Scenario | Steps (only `likes` flipped) | What goes wrong |
|---|---|---|
| 1 (cause A) | start with post + like + bookmark, remove bookmark | client hides p1 although it still matches (the `like` was never sent) |
| 2 (cause B) | start with post + like, add bookmark, remove like | deleted `like` stays on the client until the query is rebuilt. Every other query reading `like` sees it too |
| 3 (cause A) | start with post + like + bookmark, remove post | `like` refcount goes to -1. After restoring the post and removing the bookmark, the client hides p1 |

**Open fix: [mono#6636](https://github.com/rocicorp/mono/pull/6636)** (*"zero sometimes return the wrong rows for `or(cmp, exists(flip: true))`"*). It makes hydration emit the union of both branches' proofs, turns a suppressed remove into a "child remove" of the lost proof, and splits edits that move a row between branches. With it applied, all three scenarios and the whole fuzz pass.

## Files

| File | What it is |
|---|---|
| `schema.mjs` | the post/like/bookmark schema and the query |
| `fake-zero-cache.mjs` | builds Zero's real pipeline over in-memory tables and copies zero-cache's refcount logic (~30 lines, marked). It can also simulate `'yield'` markers |
| `bug1-dropped-add.mjs`, `bug2-out-of-sync-rows.mjs` | the repros, heavily commented |
| `fuzz.mjs` | 1,872 cases: all flip choices × starting rows × up to 3 writes × yields on/off |
| `patch-pr6636.mjs` | builds `node_modules/zero-pr6636` (canary + the PR's files, pinned to PR commit `ba22a48`) |
| `run-all.mjs` | the version × script table |

## How faithful is this?

- **Real:** Zero's pipeline builder and every operator (`FlippedJoin`, `UnionFanOut`, `UnionFanIn`, `Join`, ...), plus `MemorySource` for tables. zero-cache's SQLite source behaves the same way for these pushes: it applies writes one at a time and shows each operator the data as of that write.
- **Copied:** zero-cache's `Streamer` and the view-syncer's refcount switch. Zero doesn't export them.
- **Simulated:** the planner's flip choice (set by hand with `flip: ['likes']`) and the `'yield'` timer (always expired).
- **Not done here:** an end-to-end run with real Postgres, zero-cache and a browser. Bug 1 was seen end to end in tldraw (an @-mention that never showed up live, only after a reload). Bug 2's client symptoms follow from the refcounts but weren't observed in a browser.

Where we found it: tldraw's comment-notification feed, [tldraw#10872](https://github.com/tldraw/tldraw/pull/10872). Its query was `comment` with an `or(...)` access gate plus an `or(...)` of reasons, and the failure pattern fits the planner flipping the `mentions` EXISTS on production-sized data: offline, bug 1 fires in exactly the plans where `mentions` is flipped.
