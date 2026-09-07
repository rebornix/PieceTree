import assert from 'assert';
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
