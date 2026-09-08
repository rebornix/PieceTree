import assert from 'assert';
import { describe, expect, it } from 'vitest';
import {
	Color, EMPTY, IMeasured, Node, Path, descend, forEach, fromValues, insertAt, leftmost, next, nodeAt, prev, removeAt,
	replaceAt, rightmost, startOffsetOf, toArray
} from '../persistentRbTree';
import { Prng } from './prng';
import { assertPersistentTreeInvariants } from './testUtils';

/** A measured value with an identity, so that the order of values can be compared with a model. */
interface Item extends IMeasured {
	readonly id: number;
	readonly length: number;
	readonly lineFeedCnt: number;
}

let nextId = 0;

function item(length: number, lineFeedCnt: number = 0): Item {
	assert(lineFeedCnt <= length);
	return { id: nextId++, length, lineFeedCnt };
}

function randomItem(rng: Prng): Item {
	const length = rng.nextIntBetween(1, 12);
	return item(length, rng.nextInt(Math.min(length, 3) + 1));
}

function ids(root: Node<Item>): number[] {
	return toArray(root).map(v => v.id);
}

/** Offsets at which the model's values start, plus the total size. */
function boundaries(model: readonly Item[]): number[] {
	const result = [0];
	for (const value of model) {
		result.push(result[result.length - 1] + value.length);
	}
	return result;
}

function collectNodes<T extends IMeasured>(root: Node<T>, into: Set<Node<T>> = new Set()): Set<Node<T>> {
	if (root !== EMPTY) {
		into.add(root);
		collectNodes(root.left, into);
		collectNodes(root.right, into);
	}
	return into;
}

/**
 * Everything that must hold for a tree that is supposed to contain `model`:
 * the invariants, the order of the values, the totals, both directions of
 * iteration, and lookups by offset and by line feed.
 */
function assertMatchesModel(root: Node<Item>, model: readonly Item[]): void {
	assertPersistentTreeInvariants(root);
	assert.deepStrictEqual(ids(root), model.map(v => v.id));
	assert.strictEqual(root.size, model.reduce((sum, v) => sum + v.length, 0));
	assert.strictEqual(root.lf, model.reduce((sum, v) => sum + v.lineFeedCnt, 0));

	const starts = boundaries(model);

	// forward iteration with offsets, and startOffsetOf along the way
	const path = leftmost(root);
	for (let i = 0; i < model.length; i++) {
		assert(path.length > 0);
		assert.strictEqual(path[path.length - 1].value, model[i]);
		assert.strictEqual(startOffsetOf(path), starts[i]);
		assert.strictEqual(next(path), i < model.length - 1);
	}
	assert.strictEqual(path.length, 0);
	if (model.length === 0) {
		assert.deepStrictEqual(leftmost(root), []);
		assert.deepStrictEqual(rightmost(root), []);
		assert.strictEqual(nodeAt(root, 0), null);
		return;
	}

	// backward iteration
	const back = rightmost(root);
	for (let i = model.length - 1; i >= 0; i--) {
		assert.strictEqual(back[back.length - 1].value, model[i]);
		assert.strictEqual(prev(back), i > 0);
	}
	assert.strictEqual(back.length, 0);

	// lookup by offset: strictly inside a value there is one answer, at a
	// boundary the value ending there (remainder === length) or the one starting there
	for (let i = 0; i < model.length; i++) {
		for (const offset of [starts[i], starts[i] + 1, starts[i + 1] - 1, starts[i + 1]]) {
			const position = nodeAt(root, offset)!;
			assert(position !== null);
			const found = position.path[position.path.length - 1].value;
			assert.strictEqual(position.nodeStartOffset, startOffsetOf(position.path));
			assert(position.remainder >= 0 && position.remainder <= found.length);
			assert.strictEqual(position.nodeStartOffset + position.remainder, offset);
			if (offset > starts[i] && offset < starts[i + 1]) {
				assert.strictEqual(found, model[i]);
			} else {
				const index = model.indexOf(found);
				assert(index === i || (offset === starts[i] && index === i - 1) || (offset === starts[i + 1] && index === i + 1));
			}
		}
	}

	// lookup by line feed: the value containing the k-th line feed
	let lf = 0;
	for (let i = 0; i < model.length; i++) {
		for (let k = lf; k < lf + model[i].lineFeedCnt; k++) {
			const position = descend(root, (node, _startOffset, startLf) =>
				k < startLf ? -1 : k < startLf + node.value.lineFeedCnt ? 0 : 1)!;
			assert(position !== null);
			assert.strictEqual(position.path[position.path.length - 1].value, model[i]);
			assert.strictEqual(position.nodeStartLf, lf);
			assert.strictEqual(position.nodeStartOffset, starts[i]);
		}
		lf += model[i].lineFeedCnt;
	}
	assert.strictEqual(descend(root, (node, _o, startLf) => root.lf < startLf ? -1 : root.lf < startLf + node.value.lineFeedCnt ? 0 : 1), null);
}

describe('persistent red-black tree', () => {
	describe('invariant checker', () => {
		// hand-built nodes, to make sure the checker used everywhere below rejects broken trees
		const leaf = (color: Color, value: Item, left: Node<Item> = EMPTY, right: Node<Item> = EMPTY, size?: number): Node<Item> => ({
			color, left, right, value,
			size: size ?? left.size + value.length + right.size,
			lf: left.lf + value.lineFeedCnt + right.lf
		});

		it('accepts valid trees', () => {
			assert.deepStrictEqual(assertPersistentTreeInvariants(EMPTY), { nodes: 0, depth: 0 });
			const root = leaf(Color.Black, item(1), leaf(Color.Red, item(1)), leaf(Color.Red, item(1)));
			assert.deepStrictEqual(assertPersistentTreeInvariants(root), { nodes: 3, depth: 2 });
		});

		it('rejects a red root', () => {
			expect(() => assertPersistentTreeInvariants(leaf(Color.Red, item(1)))).toThrow(/root is black/);
		});

		it('rejects a red node with a red child', () => {
			const root = leaf(Color.Black, item(1), leaf(Color.Red, item(1), leaf(Color.Red, item(1))));
			expect(() => assertPersistentTreeInvariants(root)).toThrow(/red node has black children/);
		});

		it('rejects unequal black heights', () => {
			const root = leaf(Color.Black, item(1), leaf(Color.Black, item(1)));
			expect(() => assertPersistentTreeInvariants(root)).toThrow(/same number of black nodes/);
		});

		it('rejects wrong subtree totals', () => {
			const root = leaf(Color.Black, item(1), leaf(Color.Red, item(1)), EMPTY, 5);
			expect(() => assertPersistentTreeInvariants(root)).toThrow(/size is the subtree total/);
		});
	});

	describe('building', () => {
		it('is empty to start with', () => {
			assertMatchesModel(EMPTY, []);
			assert.strictEqual(toArray(EMPTY).length, 0);
			forEach(EMPTY, () => { throw new Error('not called'); });
		});

		it('fromValues builds a valid balanced tree for every small size', () => {
			for (let n = 0; n <= 130; n++) {
				const model = Array.from({ length: n }, (_, i) => item(1 + (i % 5), i % 2));
				const root = fromValues(model);
				assertMatchesModel(root, model);
				const { nodes, depth } = assertPersistentTreeInvariants(root);
				assert.strictEqual(nodes, n);
				assert(depth <= Math.floor(Math.log2(Math.max(n, 1))) + 1, `depth ${depth} for ${n} values`);
			}
		});

		it('fromValues holds the same sequence as inserting one by one', () => {
			const model = Array.from({ length: 40 }, (_, i) => item(2 + (i % 3)));
			let root: Node<Item> = EMPTY;
			for (const value of model) {
				root = insertAt(root, root.size, value);
			}
			assert.deepStrictEqual(ids(root), ids(fromValues(model)));
		});
	});

	describe('operations', () => {
		it('inserts at the start, at the end and between values', () => {
			const a = item(3), b = item(4), c = item(5), d = item(6);
			let root = insertAt(EMPTY, 0, b);
			root = insertAt(root, 0, a);
			root = insertAt(root, root.size, d);
			root = insertAt(root, 7, c);
			assertMatchesModel(root, [a, b, c, d]);
		});

		it('removes the first, a middle and the last value', () => {
			const model = Array.from({ length: 9 }, (_, i) => item(2 + i, 1));
			let root = fromValues(model);
			root = removeAt(root, 0);
			assertMatchesModel(root, model.slice(1));
			const starts = boundaries(model.slice(1));
			root = removeAt(root, starts[3]);
			const remaining = model.slice(1).filter((_, i) => i !== 3);
			assertMatchesModel(root, remaining);
			root = removeAt(root, boundaries(remaining)[remaining.length - 1]);
			assertMatchesModel(root, remaining.slice(0, -1));
			for (let i = remaining.length - 2; i >= 0; i--) {
				root = removeAt(root, 0);
			}
			assertMatchesModel(root, []);
		});

		it('replaces a value, changing its measure', () => {
			const model = Array.from({ length: 7 }, () => item(4, 1));
			let root = fromValues(model);
			const bigger = item(40, 10);
			root = replaceAt(root, 8, bigger);
			const expected = model.slice();
			expected[2] = bigger;
			assertMatchesModel(root, expected);
			const smaller = item(1, 0);
			root = replaceAt(root, 0, smaller);
			expected[0] = smaller;
			assertMatchesModel(root, expected);
		});

		it('rejects offsets that are out of range or inside a value', () => {
			const root = fromValues([item(3), item(3), item(3)]);
			expect(() => insertAt(root, -1, item(1))).toThrow(RangeError);
			expect(() => insertAt(root, 10, item(1))).toThrow(RangeError);
			expect(() => insertAt(root, 4, item(1))).toThrow(/not a boundary/);
			expect(() => removeAt(root, 9)).toThrow(RangeError);
			expect(() => removeAt(root, 5)).toThrow(/not a boundary/);
			expect(() => removeAt(EMPTY, 0)).toThrow(RangeError);
			expect(() => replaceAt(root, 9, item(1))).toThrow(RangeError);
			expect(() => replaceAt(root, 7, item(1))).toThrow(/not a boundary/);
			// the failed operations did not touch the tree
			assertMatchesModel(root, toArray(root));
		});

		it('rejects zero-length values, which could be inserted but never addressed again', () => {
			const root = fromValues([item(3), item(3)]);
			expect(() => insertAt(root, 3, item(0))).toThrow(/positive length/);
			expect(() => insertAt(root, 6, item(0))).toThrow(/positive length/);
			expect(() => insertAt(EMPTY, 0, item(0))).toThrow(/positive length/);
			expect(() => replaceAt(root, 0, item(0))).toThrow(/positive length/);
			expect(() => fromValues([item(1), item(0)])).toThrow(/positive length/);
			assertMatchesModel(root, toArray(root));
		});

		it('keeps the depth logarithmic under sequential and random insertion', () => {
			let root: Node<Item> = EMPTY;
			for (let i = 0; i < 5000; i++) {
				root = insertAt(root, root.size, item(1));
			}
			const rng = new Prng(7);
			for (let i = 0; i < 5000; i++) {
				root = insertAt(root, rng.nextInt(root.size + 1), item(1));
			}
			const { nodes, depth } = assertPersistentTreeInvariants(root);
			assert.strictEqual(nodes, 10000);
			assert(depth <= 2 * Math.log2(nodes + 1), `depth ${depth}`);
		});
	});

	describe('persistence', () => {
		it('leaves previous versions untouched', () => {
			const model = Array.from({ length: 20 }, (_, i) => item(3, i % 2));
			const v0 = fromValues(model);
			const inserted = item(9, 2);
			const v1 = insertAt(v0, 30, inserted);
			const v2 = removeAt(v1, 0);
			const replacement = item(1, 1);
			const v3 = replaceAt(v2, 3, replacement);

			assertMatchesModel(v0, model);
			const m1 = [...model.slice(0, 10), inserted, ...model.slice(10)];
			assertMatchesModel(v1, m1);
			const m2 = m1.slice(1);
			assertMatchesModel(v2, m2);
			const m3 = m2.slice();
			m3[1] = replacement;
			assertMatchesModel(v3, m3);
		});

		it('rebuilds only the path: an edit allocates O(log n) nodes', () => {
			const model = Array.from({ length: 2000 }, () => item(2, 1));
			const root = fromValues(model);
			const before = collectNodes(root);
			const { depth } = assertPersistentTreeInvariants(root);
			const rng = new Prng(11);

			const fresh = (edited: Node<Item>) => {
				let count = 0;
				for (const node of collectNodes(edited)) {
					if (!before.has(node)) {
						count++;
					}
				}
				return count;
			};

			for (let i = 0; i < 50; i++) {
				const offset = boundaries(model)[rng.nextInt(model.length + 1)];
				const inserted = insertAt(root, offset, item(5));
				assert(fresh(inserted) <= 3 * (depth + 2), 'insert');
				const removed = removeAt(root, Math.min(offset, root.size - 2));
				assert(fresh(removed) <= 6 * (depth + 2), 'remove');
				const replaced = replaceAt(root, Math.min(offset, root.size - 2), item(1));
				assert(fresh(replaced) <= depth + 1, 'replace');
			}
		});
	});

	describe('against an array model', () => {
		function run(seed: number, ops: number): void {
			const rng = new Prng(seed);
			let root: Node<Item> = EMPTY;
			let model: Item[] = [];
			const versions: { root: Node<Item>; model: Item[] }[] = [];

			for (let i = 0; i < ops; i++) {
				const starts = boundaries(model);
				const kind = model.length === 0 ? 0 : rng.nextInt(10);
				if (kind < 5) {
					const index = rng.nextInt(model.length + 1);
					const value = randomItem(rng);
					root = insertAt(root, starts[index], value);
					model = [...model.slice(0, index), value, ...model.slice(index)];
				} else if (kind < 8) {
					const index = rng.nextInt(model.length);
					root = removeAt(root, starts[index]);
					model = model.filter((_, j) => j !== index);
				} else {
					const index = rng.nextInt(model.length);
					const value = randomItem(rng);
					root = replaceAt(root, starts[index], value);
					model = model.map((v, j) => j === index ? value : v);
				}
				assertMatchesModel(root, model);
				versions.push({ root, model });
			}

			// every version is still exactly what it was when it was taken
			for (const version of versions) {
				assert.deepStrictEqual(ids(version.root), version.model.map(v => v.id));
				assertPersistentTreeInvariants(version.root);
			}
		}

		for (const seed of [1, 2, 3, 4, 5]) {
			it(`random inserts, removes and replacements (seed ${seed})`, () => {
				run(seed, 400);
			});
		}

		it('a long session that grows and then empties the tree', () => {
			const rng = new Prng(99);
			let root: Node<Item> = EMPTY;
			const model: Item[] = [];
			for (let i = 0; i < 600; i++) {
				const index = rng.nextInt(model.length + 1);
				const value = randomItem(rng);
				root = insertAt(root, boundaries(model)[index], value);
				model.splice(index, 0, value);
			}
			assertMatchesModel(root, model);
			while (model.length > 0) {
				const index = rng.nextInt(model.length);
				root = removeAt(root, boundaries(model)[index]);
				model.splice(index, 1);
				if (model.length % 50 === 0) {
					assertMatchesModel(root, model);
				}
			}
			assert.strictEqual(root, EMPTY);
		});
	});

	describe('paths', () => {
		it('next and prev walk the sequence and report the ends', () => {
			const model = [item(1), item(2), item(3)];
			const root = fromValues(model);
			const path: Path<Item> = leftmost(root);
			assert.strictEqual(path[path.length - 1].value, model[0]);
			assert(next(path));
			assert.strictEqual(path[path.length - 1].value, model[1]);
			assert(prev(path));
			assert.strictEqual(path[path.length - 1].value, model[0]);
			assert(!prev(path));
			assert.strictEqual(path.length, 0);
			const end = rightmost(root);
			assert(!next(end));
			assert.strictEqual(end.length, 0);
		});

		it('forEach visits values with their offsets and can stop early', () => {
			const model = [item(1), item(2), item(3), item(4)];
			const root = fromValues(model);
			const visited: [number, number][] = [];
			forEach(root, (value, offset) => {
				visited.push([value.id, offset]);
				return value !== model[2];
			});
			assert.deepStrictEqual(visited, [[model[0].id, 0], [model[1].id, 1], [model[2].id, 3]]);
		});

		it('a path into a version keeps working after that version is edited', () => {
			const model = Array.from({ length: 50 }, () => item(2));
			const v0 = fromValues(model);
			const position = nodeAt(v0, 21)!;
			const path = position.path;
			let v1 = v0;
			const inserted: Item[] = [];
			for (let i = 0; i < 20; i++) {
				const value = item(1);
				inserted.unshift(value);
				v1 = insertAt(v1, 0, value);
				v1 = removeAt(v1, v1.size - 2);
			}
			assertMatchesModel(v1, [...inserted, ...model.slice(0, 30)]);
			// the old path is still the old sequence
			assert.strictEqual(path[path.length - 1].value, model[10]);
			assert.strictEqual(startOffsetOf(path), 20);
			let steps = 0;
			while (next(path)) {
				steps++;
			}
			assert.strictEqual(steps, 39);
		});
	});
});
