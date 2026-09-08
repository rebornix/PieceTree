/*
 * A persistent red-black tree over a sequence of measured values (the pieces of
 * a piece tree). "Persistent" is the technical name for immutable with sharing:
 * nodes are never modified, every operation returns a new root, and the new
 * root shares every subtree it did not touch with the previous one. An edit
 * therefore costs the O(log n) nodes on the path it rebuilds, and a previous
 * root is a complete, unchanged, older version of the sequence for as long as
 * somebody holds it. That is what gives a text buffer built on it snapshots and
 * undo/redo for the price of keeping a root.
 *
 * The tree is ordered by position, not by key. Each node stores the total
 * length and line-feed count of its subtree, so a position is found by
 * descending from the root, and values are inserted at an offset that is a
 * boundary between values.
 *
 * Insertion is Okasaki's, deletion is Kahrs's ("Red-black trees with types",
 * Journal of Functional Programming, 2001), the pair fredbuf settled on as well.
 * Nodes have no parent pointers, since a shared subtree has a different parent
 * in every version. Walking up is done with the path recorded while descending
 * from the root, which is also exactly the set of nodes an edit rebuilds.
 *
 * This module does not know about pieces or buffers; it is used by the piece
 * tree, and tested on its own against an array model.
 */

/**
 * What the tree stores. `length` must be positive: values are addressed by
 * the offset at which they start, and an empty value would share its offset
 * with its neighbour, so it could be inserted but never found or removed.
 * `lineFeedCnt` must be a count (zero or more); a bad one would poison the
 * totals of every node on its path, in every version sharing them.
 */
export interface IMeasured {
	readonly length: number;
	readonly lineFeedCnt: number;
}

function checkValue(value: IMeasured): void {
	if (!(value.length > 0)) {
		throw new RangeError(`values must have a positive length, got ${value.length}`);
	}
	if (!(value.lineFeedCnt >= 0)) {
		throw new RangeError(`values must have a non-negative line feed count, got ${value.lineFeedCnt}`);
	}
}

/** Same numbering as NodeColor in rbTreeBase.ts, so that the two trees read alike. */
export const enum Color {
	Black = 0,
	Red = 1
}

export interface Node<T extends IMeasured> {
	readonly color: Color;
	readonly left: Node<T>;
	readonly right: Node<T>;
	readonly value: T;
	/** Total length of the values in this subtree. */
	readonly size: number;
	/** Total line-feed count of the values in this subtree. */
	readonly lf: number;
}

/**
 * The empty tree, shared by all trees and all versions. It is black, measures
 * zero and is its own child, so that `node.left.size` needs no special case.
 * It is frozen: nothing ever writes to it.
 */
export const EMPTY: Node<never> = (() => {
	type Mutable<T> = { -readonly [K in keyof T]: T[K] };
	// built in two steps because left and right point at the node itself
	const empty: Mutable<Node<never>> = { color: Color.Black, left: null as never, right: null as never, value: null as never, size: 0, lf: 0 };
	empty.left = empty;
	empty.right = empty;
	return Object.freeze(empty);
})();

/** The single place where a node is built, hence the single place where the metadata is computed. */
function makeNode<T extends IMeasured>(color: Color, left: Node<T>, value: T, right: Node<T>): Node<T> {
	return {
		color,
		left,
		right,
		value,
		size: left.size + value.length + right.size,
		lf: left.lf + value.lineFeedCnt + right.lf
	};
}

function paint<T extends IMeasured>(node: Node<T>, color: Color): Node<T> {
	return node.color === color ? node : makeNode(color, node.left, node.value, node.right);
}

function isRed<T extends IMeasured>(node: Node<T>): boolean {
	return node.color === Color.Red; // EMPTY is black
}

function isBlackNode<T extends IMeasured>(node: Node<T>): boolean {
	return node !== EMPTY && node.color === Color.Black;
}

function insideValue(offset: number): never {
	throw new RangeError(`offset ${offset} is not a boundary between values`);
}

/* -------------------------------------------------------------------------- */
/* Insertion                                                                  */

/**
 * Kahrs's `balance`: builds the node for `value` between two subtrees that
 * may each carry one red-red violation at their root (a child just rebuilt by
 * an insertion, or a sibling just repainted red by a deletion). Two red
 * children are recolored; a red child with a red child is rotated into a red
 * node with two black children; anything else is simply a black node.
 */
function balance<T extends IMeasured>(left: Node<T>, value: T, right: Node<T>): Node<T> {
	if (isRed(left) && isRed(right)) {
		return makeNode(Color.Red, paint(left, Color.Black), value, paint(right, Color.Black));
	}
	if (isRed(left)) {
		if (isRed(left.left)) {
			return makeNode(Color.Red, paint(left.left, Color.Black), left.value, makeNode(Color.Black, left.right, value, right));
		}
		if (isRed(left.right)) {
			const lr = left.right;
			return makeNode(Color.Red, makeNode(Color.Black, left.left, left.value, lr.left), lr.value, makeNode(Color.Black, lr.right, value, right));
		}
	}
	if (isRed(right)) {
		if (isRed(right.left)) {
			const rl = right.left;
			return makeNode(Color.Red, makeNode(Color.Black, left, value, rl.left), rl.value, makeNode(Color.Black, rl.right, right.value, right.right));
		}
		if (isRed(right.right)) {
			return makeNode(Color.Red, makeNode(Color.Black, left, value, right.left), right.value, paint(right.right, Color.Black));
		}
	}
	return makeNode(Color.Black, left, value, right);
}

function ins<T extends IMeasured>(node: Node<T>, offset: number, value: T): Node<T> {
	if (node === EMPTY) {
		return makeNode(Color.Red, EMPTY, value, EMPTY);
	}
	const leftSize = node.left.size;
	if (offset <= leftSize) {
		const left = ins(node.left, offset, value);
		return node.color === Color.Black ? balance(left, node.value, node.right) : makeNode(Color.Red, left, node.value, node.right);
	}
	const rightOffset = offset - leftSize - node.value.length;
	if (rightOffset < 0) {
		insideValue(offset);
	}
	const right = ins(node.right, rightOffset, value);
	return node.color === Color.Black ? balance(node.left, node.value, right) : makeNode(Color.Red, node.left, node.value, right);
}

/**
 * Inserts `value` so that it starts at `offset`. The offset must be a boundary
 * between values (or 0, or the total size); the new value ends up before the
 * value that currently starts there.
 */
export function insertAt<T extends IMeasured>(root: Node<T>, offset: number, value: T): Node<T> {
	checkValue(value);
	if (!Number.isInteger(offset) || offset < 0 || offset > root.size) {
		throw new RangeError(`offset ${offset} is out of range [0, ${root.size}]`);
	}
	return paint(ins(root, offset, value), Color.Black);
}

/* -------------------------------------------------------------------------- */
/* Deletion (Kahrs)                                                           */

function sub1<T extends IMeasured>(node: Node<T>): Node<T> {
	if (isBlackNode(node)) {
		return paint(node, Color.Red);
	}
	throw new Error('red-black invariant violated: expected a black node');
}

/** Rebalances a node whose left subtree lost one black node. */
function balleft<T extends IMeasured>(left: Node<T>, value: T, right: Node<T>): Node<T> {
	if (isRed(left)) {
		return makeNode(Color.Red, paint(left, Color.Black), value, right);
	}
	if (isBlackNode(right)) {
		return balance(left, value, paint(right, Color.Red));
	}
	if (isRed(right) && isBlackNode(right.left)) {
		const rl = right.left;
		return makeNode(Color.Red, makeNode(Color.Black, left, value, rl.left), rl.value, balance(rl.right, right.value, sub1(right.right)));
	}
	throw new Error('red-black invariant violated in balleft');
}

/** Rebalances a node whose right subtree lost one black node. */
function balright<T extends IMeasured>(left: Node<T>, value: T, right: Node<T>): Node<T> {
	if (isRed(right)) {
		return makeNode(Color.Red, left, value, paint(right, Color.Black));
	}
	if (isBlackNode(left)) {
		return balance(paint(left, Color.Red), value, right);
	}
	if (isRed(left) && isBlackNode(left.right)) {
		const lr = left.right;
		return makeNode(Color.Red, balance(sub1(left.left), left.value, lr.left), lr.value, makeNode(Color.Black, lr.right, value, right));
	}
	throw new Error('red-black invariant violated in balright');
}

/** Joins two subtrees of equal black height, all of `left` before all of `right` (Kahrs's `app`). */
function app<T extends IMeasured>(left: Node<T>, right: Node<T>): Node<T> {
	if (left === EMPTY) {
		return right;
	}
	if (right === EMPTY) {
		return left;
	}
	if (isRed(left) && isRed(right)) {
		const middle = app(left.right, right.left);
		if (isRed(middle)) {
			return makeNode(Color.Red, makeNode(Color.Red, left.left, left.value, middle.left), middle.value, makeNode(Color.Red, middle.right, right.value, right.right));
		}
		return makeNode(Color.Red, left.left, left.value, makeNode(Color.Red, middle, right.value, right.right));
	}
	if (isBlackNode(left) && isBlackNode(right)) {
		const middle = app(left.right, right.left);
		if (isRed(middle)) {
			return makeNode(Color.Red, makeNode(Color.Black, left.left, left.value, middle.left), middle.value, makeNode(Color.Black, middle.right, right.value, right.right));
		}
		return balleft(left.left, left.value, makeNode(Color.Black, middle, right.value, right.right));
	}
	if (isRed(right)) {
		return makeNode(Color.Red, app(left, right.left), right.value, right.right);
	}
	return makeNode(Color.Red, left.left, left.value, app(left.right, right));
}

function del<T extends IMeasured>(node: Node<T>, offset: number): Node<T> {
	const leftSize = node.left.size;
	if (offset < leftSize) {
		const left = del(node.left, offset);
		return isBlackNode(node.left) ? balleft(left, node.value, node.right) : makeNode(Color.Red, left, node.value, node.right);
	}
	if (offset === leftSize) {
		return app(node.left, node.right);
	}
	const rightOffset = offset - leftSize - node.value.length;
	if (rightOffset < 0) {
		insideValue(offset);
	}
	const right = del(node.right, rightOffset);
	return isBlackNode(node.right) ? balright(node.left, node.value, right) : makeNode(Color.Red, node.left, node.value, right);
}

/** Removes the value that starts at `offset`. */
export function removeAt<T extends IMeasured>(root: Node<T>, offset: number): Node<T> {
	if (!Number.isInteger(offset) || offset < 0 || offset >= root.size) {
		throw new RangeError(`offset ${offset} is out of range [0, ${root.size})`);
	}
	return paint(del(root, offset), Color.Black);
}

/* -------------------------------------------------------------------------- */
/* Replacement                                                                */

function rep<T extends IMeasured>(node: Node<T>, offset: number, value: T): Node<T> {
	const leftSize = node.left.size;
	if (offset < leftSize) {
		return makeNode(node.color, rep(node.left, offset, value), node.value, node.right);
	}
	if (offset === leftSize) {
		return makeNode(node.color, node.left, value, node.right);
	}
	const rightOffset = offset - leftSize - node.value.length;
	if (rightOffset < 0) {
		insideValue(offset);
	}
	return makeNode(node.color, node.left, node.value, rep(node.right, rightOffset, value));
}

/**
 * Replaces the value that starts at `offset` with `value`, which may measure
 * differently. The shape of the tree does not change, only the path is rebuilt.
 */
export function replaceAt<T extends IMeasured>(root: Node<T>, offset: number, value: T): Node<T> {
	checkValue(value);
	if (!Number.isInteger(offset) || offset < 0 || offset >= root.size) {
		throw new RangeError(`offset ${offset} is out of range [0, ${root.size})`);
	}
	return rep(root, offset, value);
}

/* -------------------------------------------------------------------------- */
/* Bulk construction                                                          */

/**
 * Builds a balanced tree holding `values` in order, in O(n). Every node of the
 * deepest level (floor(log2 n) below the root) is red and every other node is
 * black. Halving puts every empty child at that level or the one below it, so
 * every path to an empty child passes the same number of black nodes and no
 * red node has a red child. The final paint only matters for a single value,
 * whose one node is both the root and the deepest level.
 */
export function fromValues<T extends IMeasured>(values: readonly T[]): Node<T> {
	if (values.length === 0) {
		return EMPTY;
	}
	values.forEach(checkValue);
	const deepest = Math.floor(Math.log2(values.length));
	const build = (lo: number, hi: number, depth: number): Node<T> => {
		if (lo >= hi) {
			return EMPTY;
		}
		const mid = (lo + hi) >>> 1;
		return makeNode(depth === deepest ? Color.Red : Color.Black, build(lo, mid, depth + 1), values[mid], build(mid + 1, hi, depth + 1));
	};
	return paint(build(0, values.length, 0), Color.Black);
}

/* -------------------------------------------------------------------------- */
/* Lookup and iteration                                                       */

/**
 * The nodes from the root (first) to a node (last). It stands in for the
 * parent pointers a shared node cannot have; `next` and `prev` move it along
 * the sequence in place, and it stays valid for the version it was taken
 * from no matter how that version is edited later.
 */
export type Path<T extends IMeasured> = Node<T>[];

export interface NodePosition<T extends IMeasured> {
	readonly path: Path<T>;
	/** Offset of the start of the node's value in the sequence. */
	readonly nodeStartOffset: number;
	/** Offset looked up, relative to the start of the node's value; may equal its length. */
	readonly remainder: number;
}

/**
 * Finds the value containing `offset`. Like `PieceTreeBase.nodeAt`, an offset
 * at the very end of a value is reported as that value with `remainder` equal
 * to its length when the descent reaches it first. Returns null for an empty
 * tree and for offsets outside [0, size] (including NaN).
 */
export function nodeAt<T extends IMeasured>(root: Node<T>, offset: number): NodePosition<T> | null {
	const path: Path<T> = [];
	let nodeStartOffset = 0;
	let node = root;
	while (node !== EMPTY) {
		path.push(node);
		const leftSize = node.left.size;
		if (leftSize > offset) {
			node = node.left;
		} else if (leftSize + node.value.length >= offset) {
			return { path, nodeStartOffset: nodeStartOffset + leftSize, remainder: offset - leftSize };
		} else {
			offset -= leftSize + node.value.length;
			nodeStartOffset += leftSize + node.value.length;
			node = node.right;
		}
	}
	return null;
}

export interface DescentPosition<T extends IMeasured> {
	readonly path: Path<T>;
	readonly nodeStartOffset: number;
	/** Line feeds before the start of the node's value. */
	readonly nodeStartLf: number;
}

/**
 * A descent with a caller-supplied decision, for lookups that are not by
 * offset (by line, for instance). `decide` sees the node and the offset and
 * line-feed count at which its value starts, and returns a negative number to
 * go left, 0 to stop here, a positive number to go right. Returns null when
 * the descent runs off the tree.
 */
export function descend<T extends IMeasured>(
	root: Node<T>,
	decide: (node: Node<T>, nodeStartOffset: number, nodeStartLf: number) => number
): DescentPosition<T> | null {
	const path: Path<T> = [];
	let startOffset = 0;
	let startLf = 0;
	let node = root;
	while (node !== EMPTY) {
		path.push(node);
		const nodeStartOffset = startOffset + node.left.size;
		const nodeStartLf = startLf + node.left.lf;
		const direction = decide(node, nodeStartOffset, nodeStartLf);
		if (direction < 0) {
			node = node.left;
		} else if (direction === 0) {
			return { path, nodeStartOffset, nodeStartLf };
		} else {
			startOffset = nodeStartOffset + node.value.length;
			startLf = nodeStartLf + node.value.lineFeedCnt;
			node = node.right;
		}
	}
	return null;
}

/** Path to the first value, or an empty path for an empty tree. */
export function leftmost<T extends IMeasured>(root: Node<T>): Path<T> {
	const path: Path<T> = [];
	for (let node = root; node !== EMPTY; node = node.left) {
		path.push(node);
	}
	return path;
}

/** Path to the last value, or an empty path for an empty tree. */
export function rightmost<T extends IMeasured>(root: Node<T>): Path<T> {
	const path: Path<T> = [];
	for (let node = root; node !== EMPTY; node = node.right) {
		path.push(node);
	}
	return path;
}

/**
 * Moves the path to the next value in the sequence; returns false (leaving the
 * path empty) at the end. The path must be non-empty, as are the paths nodeAt,
 * descend, leftmost and rightmost return for a non-empty tree.
 */
export function next<T extends IMeasured>(path: Path<T>): boolean {
	let node = path[path.length - 1];
	if (node.right !== EMPTY) {
		for (let n = node.right; n !== EMPTY; n = n.left) {
			path.push(n);
		}
		return true;
	}
	while (path.length > 1) {
		path.pop();
		const parent = path[path.length - 1];
		if (parent.left === node) {
			return true;
		}
		node = parent;
	}
	path.length = 0;
	return false;
}

/** Moves the path to the previous value in the sequence; returns false (leaving the path empty) at the start. The path must be non-empty. */
export function prev<T extends IMeasured>(path: Path<T>): boolean {
	let node = path[path.length - 1];
	if (node.left !== EMPTY) {
		for (let n = node.left; n !== EMPTY; n = n.right) {
			path.push(n);
		}
		return true;
	}
	while (path.length > 1) {
		path.pop();
		const parent = path[path.length - 1];
		if (parent.right === node) {
			return true;
		}
		node = parent;
	}
	path.length = 0;
	return false;
}

/** Offset at which the value at the end of the (non-empty) path starts. */
export function startOffsetOf<T extends IMeasured>(path: Path<T>): number {
	let offset = 0;
	for (let i = 0; i < path.length - 1; i++) {
		if (path[i].right === path[i + 1]) {
			offset += path[i].left.size + path[i].value.length;
		}
	}
	return offset + path[path.length - 1].left.size;
}

/**
 * Visits the values in order with the offset at which each starts. The
 * callback may return false to stop.
 */
export function forEach<T extends IMeasured>(root: Node<T>, callback: (value: T, startOffset: number) => boolean | void): void {
	const path = leftmost(root);
	let offset = 0;
	while (path.length > 0) {
		const value = path[path.length - 1].value;
		if (callback(value, offset) === false) {
			return;
		}
		offset += value.length;
		next(path);
	}
}

/** The values in order. */
export function toArray<T extends IMeasured>(root: Node<T>): T[] {
	const values: T[] = [];
	forEach(root, value => { values.push(value); });
	return values;
}
