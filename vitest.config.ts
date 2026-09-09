import { defineConfig } from 'vitest/config';

// The suites that are written against the shared piece tree interface (the
// ported VS Code suite, the differential fuzzer, the builder tests) run twice:
// once on PieceTreeBase and once on PersistentPieceTree. The environment
// variable is read by src/test/testUtils.ts, which builds the trees.
const sharedSuites = ['src/test/pieceTreeBase.test.ts', 'src/test/differential.test.ts', 'src/test/pieceTreeBuilder.test.ts'];

export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: { name: 'mutable', include: ['src/**/*.test.ts'] }
			},
			{
				extends: true,
				test: { name: 'persistent', include: sharedSuites, env: { PIECE_TREE_FLAVOR: 'persistent' } }
			}
		],
		coverage: {
			provider: 'v8',
			// report on the whole library, not only on files the tests happen to load
			include: ['src/**/*.ts'],
			exclude: ['src/test/**', 'src/benchmark/**'],
			reporter: ['text', 'lcov'],
		},
	},
});
