import { describe, expect, it } from 'vitest';
import { PersistentPieceTree } from '../persistentPieceTree';
import { createTextBuffer, setTreeFlavor } from './testUtils';
import { createTree, generateScenario } from './differential';

/*
 * The ported VS Code suite and the differential fuzzer, run against the
 * persistent piece tree. The flavor is set before the suites are loaded, so
 * every createTextBuffer / createTree in them builds a PersistentPieceTree
 * and every assertTreeInvariants checks the persistent tree's invariants.
 */
setTreeFlavor('persistent');

describe('persistent flavor', () => {
	it('is what the suites below are built on', () => {
		expect(createTextBuffer(['a\nb'])).toBeInstanceOf(PersistentPieceTree);
		expect(createTree(generateScenario({ seed: 1, mode: 'mixed', opCount: 1 }))).toBeInstanceOf(PersistentPieceTree);
	});
});

await import('./pieceTreeBase.test');
await import('./differential.test');
