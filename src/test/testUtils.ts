import assert from 'assert';
import { Color, EMPTY, IMeasured, Node } from '../persistentRbTree';
import { ITextSnapshot, PieceTreeBase } from '../pieceTreeBase';
import { DefaultEndOfLine, PieceTreeTextBufferBuilder } from '../pieceTreeBuilder';
import { NodeColor, SENTINEL, TreeNode } from '../rbTreeBase';

export function createTextBuffer(val: string[], normalizeEOL: boolean = true): PieceTreeBase {
	const bufferBuilder = new PieceTreeTextBufferBuilder();
	for (const chunk of val) {
		bufferBuilder.acceptChunk(chunk);
	}
	const factory = bufferBuilder.finish(normalizeEOL);
	return factory.create(DefaultEndOfLine.LF);
}

export function readSnapshot(snapshot: ITextSnapshot): string {
	let ret = '';
	let tmp = snapshot.read();
	while (tmp !== null) {
		ret += tmp;
		tmp = snapshot.read();
	}
	return ret;
}

/**
 * Checks the red-black tree invariants plus the piece tree's cached
 * subtree metadata (size_left / lf_left) against a full recount.
 */
export function assertTreeInvariants(T: PieceTreeBase): void {
	assert(SENTINEL.color === NodeColor.Black);
	assert(SENTINEL.parent === SENTINEL);
	assert(SENTINEL.left === SENTINEL);
	assert(SENTINEL.right === SENTINEL);
	assert(SENTINEL.size_left === 0);
	assert(SENTINEL.lf_left === 0);
	assertValidTree(T);
}

function depth(n: TreeNode): number {
	if (n === SENTINEL) {
		// The leafs are black
		return 1;
	}
	assert(depth(n.left) === depth(n.right));
	return (n.color === NodeColor.Black ? 1 : 0) + depth(n.left);
}

function assertValidNode(n: TreeNode): { size: number; lf_cnt: number } {
	if (n === SENTINEL) {
		return { size: 0, lf_cnt: 0 };
	}

	const l = n.left;
	const r = n.right;

	if (n.color === NodeColor.Red) {
		assert(l.color === NodeColor.Black);
		assert(r.color === NodeColor.Black);
	}

	const actualLeft = assertValidNode(l);
	assert(actualLeft.lf_cnt === n.lf_left);
	assert(actualLeft.size === n.size_left);
	const actualRight = assertValidNode(r);

	return { size: n.size_left + n.piece.length + actualRight.size, lf_cnt: n.lf_left + n.piece.lineFeedCnt + actualRight.lf_cnt };
}

function assertValidTree(T: PieceTreeBase): void {
	if (T.root === SENTINEL) {
		return;
	}
	assert(T.root.color === NodeColor.Black);
	assert(depth(T.root.left) === depth(T.root.right));
	assertValidNode(T.root);
}

/**
 * Checks the red-black invariants of a persistent tree (black root, no red
 * node with a red child, equal black height on every path), its subtree
 * totals against a full recount, and that the shared EMPTY node is untouched.
 * Returns the number of nodes and the maximum depth, for the tests that bound them.
 */
export function assertPersistentTreeInvariants<T extends IMeasured>(root: Node<T>): { nodes: number; depth: number } {
	assert(Object.isFrozen(EMPTY));
	assert(EMPTY.color === Color.Black);
	assert(EMPTY.left === EMPTY && EMPTY.right === EMPTY);
	assert(EMPTY.size === 0 && EMPTY.lf === 0);
	if (root === EMPTY) {
		return { nodes: 0, depth: 0 };
	}
	assert(root.color === Color.Black, 'the root is black');

	let nodes = 0;
	let maxDepth = 0;
	// returns the black height of the subtree
	const check = (node: Node<T>, depth: number): number => {
		if (node === EMPTY) {
			return 1;
		}
		nodes++;
		maxDepth = Math.max(maxDepth, depth);
		if (node.color === Color.Red) {
			assert(node.left.color === Color.Black && node.right.color === Color.Black, 'a red node has black children');
		}
		assert(node.value.length >= 0 && node.value.lineFeedCnt >= 0);
		assert(node.size === node.left.size + node.value.length + node.right.size, 'size is the subtree total');
		assert(node.lf === node.left.lf + node.value.lineFeedCnt + node.right.lf, 'lf is the subtree total');
		const leftHeight = check(node.left, depth + 1);
		const rightHeight = check(node.right, depth + 1);
		assert(leftHeight === rightHeight, 'every path has the same number of black nodes');
		return leftHeight + (node.color === Color.Black ? 1 : 0);
	};
	check(root, 1);
	return { nodes, depth: maxDepth };
}
