// A tiny stand-in for zero-cache, built from Zero's own query engine.
//
// Real zero-cache does roughly this for every query a client subscribes to:
//
//   1. Build a "pipeline" (a graph of operators) from the query's AST.
//   2. Hydrate: pull the current results through the pipeline and send every row
//      it touched to the client.
//   3. Advance: for every database write, push the change through the pipeline and
//      send the resulting row adds/removes to the client.
//
// The client keeps its own copy of the rows and runs the same query locally over
// that copy. So if zero-cache forgets to send a row, or forgets to tell the client
// a row went away, the client shows the wrong thing.
//
// What is real here and what is copied:
//   - REAL (imported from @rocicorp/zero): the pipeline builder and every operator
//     (Join, FlippedJoin, UnionFanOut, UnionFanIn, Take, ...), and MemorySource
//     for tables.
//   - COPIED (about 30 lines, marked below): how zero-cache turns pipeline output
//     into per-row reference counts. Zero doesn't export that code.
//   - SIMULATED: the query planner's choice of which EXISTS to "flip" (we set it
//     by hand), and the 'yield' markers that zero-cache's SQLite table source
//     sends when it's been busy for too long.

// Pick which copy of Zero to test. Default: the version from package.json.
// `ZERO_PKG=zero-canary node bug1-dropped-add.mjs` tests the 1.11 canary instead.
export const zeroPackage = process.env.ZERO_PKG ?? '@rocicorp/zero'

// These internals aren't in the package's "exports" list, so import them by file path.
const zeroOut = new URL(`./node_modules/${zeroPackage}/out/`, import.meta.url).href
const { MemorySource } = await import(zeroOut + 'zql/src/ivm/memory-source.js')
const { MemoryStorage } = await import(zeroOut + 'zql/src/ivm/memory-storage.js')
const { buildPipeline } = await import(zeroOut + 'zql/src/builder/builder.js')
const { completeOrdering } = await import(zeroOut + 'zql/src/query/complete-ordering.js')

/**
 * Start a fake zero-cache for one query.
 *
 * @param schema      a Zero schema (from createSchema)
 * @param query       a ZQL query built with createBuilder(schema)
 * @param rows        starting table contents, e.g. { post: [{ id: 'p1' }] }
 * @param flip        names of relationships whose EXISTS the planner "flipped", e.g. ['likes']
 * @param yields      true = sources send 'yield' markers like zero-cache's SQLite source does
 */
export function startFakeZeroCache({ schema, query, rows, flip = [], yields = false }) {
	const tables = schema.tables
	const primaryKeyOf = (tableName) => tables[tableName].primaryKey

	// completeOrdering adds the primary key to every ORDER BY. zero-cache does the same
	// before building a pipeline.
	const plainAst = completeOrdering(query.ast, primaryKeyOf)
	const serverAst = setFlips(plainAst, new Set(flip))

	// One in-memory table per schema table, filled with the starting rows.
	const sources = createSources(tables, rows)

	// The rows the client has, keyed by "table:primaryKey".
	// refCount = how many times the server said "you need this row" minus how many
	// times it said "you can drop it". The client keeps a row while refCount > 0.
	const clientStore = new Map()

	// --- start of code copied from zero-cache ---------------------------------------
	// Mirrors Streamer#streamChanges / #streamNodes in
	// zero-cache/src/services/view-syncer/pipeline-driver.js and the refcount switch
	// in view-syncer.js. Walks a pipeline change and bumps every row inside it,
	// including rows in hidden EXISTS relationships.
	function countRows(tableSchema, type, nodes) {
		if (tableSchema.system === 'permissions') return
		for (const node of nodes) {
			if (node === 'yield') continue
			const key = tableSchema.tableName + ':' + rowKey(tableSchema.tableName, node.row)
			const entry = clientStore.get(key) ?? {
				table: tableSchema.tableName,
				row: node.row,
				refCount: 0,
			}
			if (type === 'add') entry.refCount++
			if (type === 'remove') entry.refCount--
			if (type !== 'remove') entry.row = node.row
			clientStore.set(key, entry)
			if (type === 'edit') continue // edits send only the row itself, no relationships
			for (const [relationshipName, children] of Object.entries(node.relationships)) {
				countRows(tableSchema.relationships[relationshipName], type, children())
			}
		}
	}
	function countChange(tableSchema, change) {
		const [type] = change
		if (type === 0) countRows(tableSchema, 'add', [change[1]])
		if (type === 1) countRows(tableSchema, 'remove', [change[1]])
		if (type === 2) countRows(tableSchema, 'edit', [{ row: change[1].row, relationships: {} }])
		// type 3 = "child change": something changed inside one relationship of a row.
		if (type === 3) {
			const { relationshipName, change: inner } = change[2]
			countChange(tableSchema.relationships[relationshipName], inner)
		}
	}
	// --- end of code copied from zero-cache -----------------------------------------

	const pipeline = buildPipeline(serverAst, makeDelegate(sources, yields), 'query-1')
	const rootSchema = pipeline.getSchema()
	pipeline.setOutput({
		*push(change) {
			countChange(rootSchema, change)
		},
	})

	// Hydrate: fetch everything once and send it all to the client.
	for (const node of pipeline.fetch({})) {
		if (node !== 'yield') countRows(rootSchema, 'add', [node])
	}

	function rowKey(tableName, row) {
		return primaryKeyOf(tableName)
			.map((column) => row[column])
			.join('/')
	}

	function currentRows() {
		const result = {}
		for (const [tableName, source] of Object.entries(sources)) {
			result[tableName] = [...source.data] // MemorySource keeps rows in a sorted set
		}
		return result
	}

	return {
		/** Write to the database. zero-cache pushes each write through the pipeline. */
		write(tableName, type, row) {
			const change = type === 'add' ? [0, row, null] : [1, row, null]
			for (const _ of sources[tableName].push(change));
		},

		/** What the query returns if you run it from scratch on the real data. */
		correctResult() {
			return runQueryOnce(tables, plainAst, currentRows())
		},

		/** What the client shows: the same query, run over the rows the client was sent. */
		clientResult() {
			const rowsOnClient = {}
			for (const { table, row, refCount } of clientStore.values()) {
				if (refCount > 0) (rowsOnClient[table] ??= []).push(row)
			}
			return runQueryOnce(tables, plainAst, rowsOnClient)
		},

		/** Rows the client still holds although they were deleted from the database. */
		staleRowsOnClient() {
			const now = currentRows()
			const stillExists = ({ table, row }) =>
				(now[table] ?? []).some((r) => rowKey(table, r) === rowKey(table, row))
			return [...clientStore]
				.filter(([, entry]) => entry.refCount > 0 && !stillExists(entry))
				.map(([key]) => key)
		},

		/** Rows whose refcount went below zero: the server removed more times than it added. */
		negativeRefCounts() {
			return [...clientStore]
				.filter(([, entry]) => entry.refCount < 0)
				.map(([key, entry]) => `${key} = ${entry.refCount}`)
		},
	}
}

/** Mark the EXISTS conditions for the given relationship names with `flip: true`. */
function setFlips(ast, flipNames) {
	const visit = (condition) => {
		if (!condition) return condition
		if (condition.type === 'and' || condition.type === 'or') {
			return { ...condition, conditions: condition.conditions.map(visit) }
		}
		if (condition.type === 'correlatedSubquery') {
			const subquery = condition.related.subquery
			// the query builder names aliases "zsubq_<relationship name>"
			const name = subquery.alias.replace(/^zsubq_/, '')
			return {
				...condition,
				related: { ...condition.related, subquery: { ...subquery, where: visit(subquery.where) } },
				...(flipNames.has(name) ? { flip: true } : {}),
			}
		}
		return condition
	}
	return { ...ast, where: visit(ast.where) }
}

function createSources(tables, rows) {
	const sources = {}
	for (const [tableName, table] of Object.entries(tables)) {
		const source = new MemorySource(tableName, table.columns, table.primaryKey)
		for (const row of rows[tableName] ?? []) for (const _ of source.push([0, row, null]));
		sources[tableName] = source
	}
	return sources
}

/** Run a query once, with no flips, and return the primary keys of the result rows. */
function runQueryOnce(tables, ast, rows) {
	const pipeline = buildPipeline(ast, makeDelegate(createSources(tables, rows), false), 'check')
	const primaryKey = pipeline.getSchema().primaryKey
	const keys = []
	for (const node of pipeline.fetch({})) {
		if (node !== 'yield') keys.push(primaryKey.map((c) => node.row[c]).join('/'))
	}
	return keys
}

/** The object buildPipeline uses to get tables and storage. */
function makeDelegate(sources, yields) {
	return {
		getSource: (tableName) =>
			yields ? withYields(sources[tableName]) : sources[tableName],
		createStorage: () => new MemoryStorage(),
		decorateInput: (input) => input,
		decorateFilterInput: (input) => input,
		decorateSourceInput: (input) => input,
		addEdge() {},
		enableNotExists: true,
	}
}

/**
 * Make a table send 'yield' markers the way zero-cache's SQLite TableSource does.
 *
 * zero-cache runs many queries on one thread. To stay responsive, its TableSource
 * checks a timer after reading each row, and once the current batch of work has run
 * longer than ZERO_YIELD_THRESHOLD_MS (default 10ms), it emits the string 'yield'
 * before the next row. Operators are supposed to pass 'yield' along and never treat
 * it as a row.
 *
 * Whether the timer has run out depends on how busy the server is, so in production
 * it happens sometimes, not always. Here we pretend the timer has always run out,
 * so every row read is preceded by a 'yield'. That makes the bug deterministic.
 */
function withYields(source) {
	return {
		get tableSchema() {
			return source.tableSchema
		},
		connect(...args) {
			const connection = source.connect(...args)
			const fetchRows = connection.fetch.bind(connection)
			connection.fetch = function* (request) {
				for (const node of fetchRows(request)) {
					if (node !== 'yield') yield 'yield'
					yield node
				}
			}
			return connection
		},
		push: (change) => source.push(change),
		genPush: (change) => source.genPush(change),
	}
}
