// The smallest schema that shows both bugs.
//
//   post      a post, identified by id
//   like      "user X liked post Y"
//   bookmark  "user X bookmarked post Y"
//
// The query: "posts I liked OR bookmarked".
//
// With an OR of two EXISTS, Zero builds this pipeline (once the planner flips at least
// one side):
//
//                      post table
//                          |
//                    UnionFanOut        sends each post change down both branches
//                     /         \
//        EXISTS likes             EXISTS bookmarks
//        (flipped: starts from    (normal: starts from the post,
//         my likes, looks up       looks up its bookmarks)
//         their posts)
//                     \         /
//                     UnionFanIn        merges both branches, removes duplicates
//                          |
//                       result
//
// "Flipped" is the planner's choice: rather than checking every post for a like by me,
// it starts from my few likes and looks up those posts. It's faster when I've liked
// only a few posts. Both bugs are in how UnionFanIn merges the two branches.

import { createBuilder, createSchema, relationships, string, table } from '@rocicorp/zero'

const post = table('post').columns({ id: string() }).primaryKey('id')

const like = table('like')
	.columns({ postId: string(), userId: string() })
	.primaryKey('postId', 'userId')

const bookmark = table('bookmark')
	.columns({ postId: string(), userId: string() })
	.primaryKey('postId', 'userId')

const postRelationships = relationships(post, ({ many }) => ({
	likes: many({ sourceField: ['id'], destField: ['postId'], destSchema: like }),
	bookmarks: many({ sourceField: ['id'], destField: ['postId'], destSchema: bookmark }),
}))

export const schema = createSchema({
	tables: [post, like, bookmark],
	relationships: [postRelationships],
})

const zql = createBuilder(schema)

export const postsILikedOrBookmarked = zql.post.where(({ or, exists }) =>
	or(
		exists('likes', (l) => l.where('userId', '=', 'me')),
		exists('bookmarks', (b) => b.where('userId', '=', 'me'))
	)
)

// Handy rows
export const p1 = { id: 'p1' }
export const myLike = { postId: 'p1', userId: 'me' }
export const myBookmark = { postId: 'p1', userId: 'me' }
