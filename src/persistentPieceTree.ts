import { CharCode } from './common/charCode';
import { ITextSnapshot } from './common/model';
import { Position } from './common/position';
import { Range } from './common/range';
import * as rb from './persistentRbTree';
import * as buffers from './pieceBuffers';
import { AverageBufferSize, BufferCursor, Piece, StringBuffer, createLineStartsFast } from './pieceBuffers';

/*
 * The piece tree on the persistent red-black tree: the same text buffer as
 * PieceTreeBase, with a root that is never modified. An edit builds a new
 * root that shares everything it did not touch with the previous one, so a
 * version of the document is a root plus a few scalars (getVersion /
 * restoreVersion, both O(1)), and undo/redo is a stack of versions
 * (PieceTreeHistory) instead of a stack of inverse edits.
 *
 * The algorithms are PieceTreeBase's (VS Code, MIT) restated for a tree
 * without parent pointers. Reads: a descent from the root records its path,
 * and the path is what walks to the neighbouring pieces afterwards; the
 * metadata is per subtree rather than per left subtree, which turns
 * PieceTreeBase's running subtractions into absolute offsets and line counts
 * handed to the descent callback. Writes: every in-place change of a node
 * ("shorten this piece", "insert after that node") becomes a tree operation
 * addressed by the offset at which the piece starts, and neighbouring pieces
 * are looked up again by offset after each operation rather than followed
 * through node references, which the new root does not share with the old.
 *
 * The text buffers are shared by all versions: the original chunks are never
 * written, and the change buffer only ever grows at its end, so a piece of an
 * old version keeps meaning the same text. The one place PieceTreeBase
 * rewrites the change buffer (appendToNode popping a line start when a typed
 * \n joins a \r at the end of the buffer) is not taken here; that insert goes
 * through the general path instead, which produces the same text.
 */

type Node = rb.Node<Piece>;
type Path = rb.Path<Piece>;

/**
 * The text buffers behind a tree: index 0 is the change buffer, the others
 * are the read-only original chunks. Shared by every version built on them
 * (setEOL starts a new set), which is why the end of the change buffer lives
 * here and not on the tree.
 */
interface BufferState {
	readonly buffers: StringBuffer[];
	lastChangeBufferPos: BufferCursor;
}

/**
 * A version of the document, as returned by `PersistentPieceTree.getVersion()`
 * and accepted by `restoreVersion()`. Taking one is O(1), restoring one is
 * O(1); what it keeps alive is the O(log n) tree nodes each edit since the
 * previous version allocated. It is only ever created by the tree.
 */
export interface PieceTreeVersion {
	readonly eol: '\r\n' | '\n';
	readonly eolNormalized: boolean;
	readonly length: number;
	readonly lineCount: number;
}

/**
 * The version as the tree sees it: an immutable root plus the buffer state
 * the root's pieces refer to. The state is shared with every other version on
 * the same buffers and is not copied: the change buffer only grows at its end,
 * so old pieces keep their meaning, and `lastChangeBufferPos` must stay the
 * buffer's current end (a version-private copy would let a later append
 * overwrite text another version relies on).
 */
class Version implements PieceTreeVersion {
	constructor(
		readonly tree: PersistentPieceTree,
		readonly root: Node,
		readonly state: BufferState,
		readonly eol: '\r\n' | '\n',
		readonly eolNormalized: boolean
	) { }

	get length(): number {
		return this.root.size;
	}

	get lineCount(): number {
		return this.root.lf + 1;
	}

	/** The same document state: same root, same buffers, same line-ending flags. */
	sameAs(other: Version): boolean {
		return this.root === other.root && this.state === other.state && this.eol === other.eol && this.eolNormalized === other.eolNormalized;
	}
}

/**
 * Undo/redo for a PersistentPieceTree as two stacks of versions. Call
 * `pushUndoStop()` before a change or a group of changes to make it undoable;
 * `undo()` and `redo()` switch the tree's version in O(1). Edits made after
 * an undo without a new undo stop still discard the redo stack, as they do in
 * an editor: the history notices that the tree moved on without it. The
 * oldest undo stops are dropped beyond `limit`, so the history's memory is
 * bounded by `limit` times what the edits between two stops allocate.
 */
export class PieceTreeHistory {
	private readonly _undo: Version[] = [];
	private readonly _redo: Version[] = [];
	/** The version the history last recorded or restored; the tree being elsewhere means it was edited since. */
	private _last: Version;

	private readonly _tree: PersistentPieceTree;
	private readonly _limit: number;

	constructor(tree: PersistentPieceTree, limit: number = 1000) {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new RangeError(`the history needs a limit of at least 1, got ${limit}`);
		}
		this._tree = tree;
		this._limit = limit;
		this._last = tree.getVersion() as Version;
	}

	/** Whether `undo()` would change the document. */
	get canUndo(): boolean {
		const top = this._undo[this._undo.length - 1];
		return top !== undefined && (this._undo.length > 1 || !top.sameAs(this._tree.getVersion() as Version));
	}

	/** Whether `redo()` would change the document; false once the tree was edited after an undo. */
	get canRedo(): boolean {
		return this._redo.length > 0 && (this._tree.getVersion() as Version).sameAs(this._last);
	}

	/** Makes the current version an undo stop; the edits that follow are undone together, back to it. */
	pushUndoStop(): void {
		const current = this._tree.getVersion() as Version;
		this._noteEditsSince(current);
		const top = this._undo[this._undo.length - 1];
		if (top === undefined || !top.sameAs(current)) {
			this._pushUndo(current);
		}
		this._last = current;
	}

	/** Returns to the last undo stop; the version left behind becomes redoable. */
	undo(): boolean {
		const current = this._tree.getVersion() as Version;
		this._noteEditsSince(current);
		// an undo stop at the current version has nothing to undo yet; it stays for the edits to come
		let i = this._undo.length - 1;
		while (i >= 0 && this._undo[i].sameAs(current)) {
			i--;
		}
		if (i < 0) {
			return false;
		}
		const target = this._undo[i];
		this._undo.length = i;
		this._redo.push(current);
		this._tree.restoreVersion(target);
		this._last = target;
		return true;
	}

	redo(): boolean {
		const current = this._tree.getVersion() as Version;
		this._noteEditsSince(current);
		const target = this._redo.pop();
		if (target === undefined) {
			return false;
		}
		this._pushUndo(current);
		this._tree.restoreVersion(target);
		this._last = target;
		return true;
	}

	/** Edits made since the history last saw the tree start a new future: the old one cannot be redone. */
	private _noteEditsSince(current: Version): void {
		if (!current.sameAs(this._last)) {
			this._redo.length = 0;
			this._last = current;
		}
	}

	private _pushUndo(version: Version): void {
		if (this._undo.length >= this._limit) {
			// dropping the oldest stop is O(limit); fine for the sizes a history has
			this._undo.shift();
		}
		this._undo.push(version);
	}
}

/** A piece in the tree, addressed by the path from the root, and a position inside it. */
export interface NodePosition {
	readonly path: Path;
	/** Offset into the piece; may equal the piece's length. */
	readonly remainder: number;
	/** Offset of the start of the piece in the document. */
	readonly nodeStartOffset: number;
}

function last(path: Path): Node {
	return path[path.length - 1];
}

/**
 * The piece the most recent line lookup ended in, reused when the next line
 * is in the same piece (reading consecutive lines does this all the time).
 * Tied to the root it was taken from, since a path into another version is
 * meaningless here.
 */
interface LineCacheEntry {
	readonly root: Node;
	readonly path: Path;
	/** The line on which the piece starts. */
	readonly nodeStartLineNumber: number;
}

class PersistentPieceTreeSnapshot implements ITextSnapshot {
	private readonly _path: Path;
	private _started = false;

	constructor(root: Node, private readonly _buffers: StringBuffer[], private readonly _BOM: string) {
		this._path = rb.leftmost(root);
	}

	read(): string | null {
		if (!this._started) {
			this._started = true;
			if (this._path.length === 0) {
				return this._BOM;
			}
			return this._BOM + buffers.getPieceContent(this._buffers, last(this._path).value);
		}
		if (this._path.length === 0 || !rb.next(this._path)) {
			return null;
		}
		return buffers.getPieceContent(this._buffers, last(this._path).value);
	}
}

export class PersistentPieceTree {
	private _root!: Node;
	private _state!: BufferState;
	private _EOL!: '\r\n' | '\n';
	private _EOLLength!: number;
	private _EOLNormalized!: boolean;
	private _lastVisitedLine!: { lineNumber: number; value: string };
	private _lineCache!: LineCacheEntry | null;

	constructor(chunks: StringBuffer[], eol: '\r\n' | '\n', eolNormalized: boolean) {
		this._create(chunks, eol, eolNormalized);
	}

	private _create(chunks: StringBuffer[], eol: '\r\n' | '\n', eolNormalized: boolean): void {
		this._state = { buffers: [new StringBuffer('', [0])], lastChangeBufferPos: { line: 0, column: 0 } };
		this._EOL = eol;
		this._EOLLength = eol.length;
		this._EOLNormalized = eolNormalized;
		this._lastVisitedLine = { lineNumber: 0, value: '' };
		this._lineCache = null;

		const pieces: Piece[] = [];
		for (const chunk of chunks) {
			if (chunk.buffer.length === 0) {
				continue;
			}
			if (!chunk.lineStarts) {
				chunk.lineStarts = createLineStartsFast(chunk.buffer);
			}
			const lastLine = chunk.lineStarts.length - 1;
			pieces.push(new Piece(
				this._buffers.length,
				{ line: 0, column: 0 },
				{ line: lastLine, column: chunk.buffer.length - chunk.lineStarts[lastLine] },
				lastLine,
				chunk.buffer.length
			));
			this._buffers.push(chunk);
		}
		this._root = rb.fromValues(pieces);
	}

	private get _buffers(): StringBuffer[] {
		return this._state.buffers;
	}

	// #region Versions

	/** The current version, O(1). It stays valid whatever happens to the tree afterwards. */
	public getVersion(): PieceTreeVersion {
		return new Version(this, this._root, this._state, this._EOL, this._EOLNormalized);
	}

	/** Makes `version` the current document again, O(1). It must have been taken from this tree. */
	public restoreVersion(version: PieceTreeVersion): void {
		if (!(version instanceof Version) || version.tree !== this) {
			throw new TypeError('not a version of this tree');
		}
		this._root = version.root;
		this._state = version.state;
		this._EOL = version.eol;
		this._EOLLength = version.eol.length;
		this._EOLNormalized = version.eolNormalized;
		// the line cache is keyed by root, so it needs no reset; the last visited line is not
		this._lastVisitedLine = { lineNumber: 0, value: '' };
	}

	/** The root of the current version. Read-only, as is everything reachable from it. */
	public get root(): Node {
		return this._root;
	}

	// #endregion

	// #region Buffer API

	public getEOL(): '\r\n' | '\n' {
		return this._EOL;
	}

	/** Re-chunks the document with `newEOL` as its only line break; older versions keep their buffers. */
	public setEOL(newEOL: '\r\n' | '\n'): void {
		const min = AverageBufferSize - Math.floor(AverageBufferSize / 3);
		const max = min * 2;

		let tempChunk = '';
		let tempChunkLen = 0;
		const chunks: StringBuffer[] = [];
		const flush = () => {
			const text = tempChunk.replace(/\r\n|\r|\n/g, newEOL);
			chunks.push(new StringBuffer(text, createLineStartsFast(text)));
		};
		rb.forEach(this._root, piece => {
			const str = buffers.getPieceContent(this._buffers, piece);
			const len = str.length;
			if (tempChunkLen <= min || tempChunkLen + len < max) {
				tempChunk += str;
				tempChunkLen += len;
				return;
			}
			flush();
			tempChunk = str;
			tempChunkLen = len;
		});
		if (tempChunkLen > 0) {
			flush();
		}
		this._create(chunks, newEOL, true);
	}

	public getLength(): number {
		return this._root.size;
	}

	public getLineCount(): number {
		return this._root.lf + 1;
	}

	public createSnapshot(BOM: string): ITextSnapshot {
		return new PersistentPieceTreeSnapshot(this._root, this._buffers, BOM);
	}

	public equal(other: PersistentPieceTree): boolean {
		if (this.getLength() !== other.getLength()) {
			return false;
		}
		if (this.getLineCount() !== other.getLineCount()) {
			return false;
		}

		let equal = true;
		rb.forEach(this._root, (piece, offset) => {
			const str = buffers.getPieceContent(this._buffers, piece);
			const startPosition = other.nodeAt(offset);
			const endPosition = other.nodeAt(offset + str.length);
			equal = str === other.getValueInRange2(startPosition, endPosition);
			return equal;
		});
		return equal;
	}

	public getOffsetAt(lineNumber: number, column: number): number {
		const position = rb.descend(this._root, (node, _nodeStartOffset, nodeStartLf) => {
			if (node.left !== rb.EMPTY && nodeStartLf + 1 >= lineNumber) {
				return -1;
			}
			if (nodeStartLf + node.value.lineFeedCnt + 1 >= lineNumber) {
				return 0;
			}
			return 1;
		});
		if (position === null) {
			// past the last line
			return this._root.size;
		}
		const piece = last(position.path).value;
		return position.nodeStartOffset + buffers.getAccumulatedValue(this._buffers, piece, lineNumber - position.nodeStartLf - 2) + column - 1;
	}

	public getPositionAt(offset: number): Position {
		offset = Math.floor(offset);
		offset = Math.max(0, offset);

		let x = this._root;
		let lfCnt = 0;
		const originalOffset = offset;

		while (x !== rb.EMPTY) {
			const leftSize = x.left.size;
			if (leftSize !== 0 && leftSize >= offset) {
				x = x.left;
			} else if (leftSize + x.value.length >= offset) {
				const out = buffers.getIndexOf(this._buffers, x.value, offset - leftSize);

				lfCnt += x.left.lf + out.index;

				if (out.index === 0) {
					const lineStartOffset = this.getOffsetAt(lfCnt + 1, 1);
					const column = originalOffset - lineStartOffset;
					return new Position(lfCnt + 1, column + 1);
				}

				return new Position(lfCnt + 1, out.remainder + 1);
			} else {
				offset -= leftSize + x.value.length;
				lfCnt += x.left.lf + x.value.lineFeedCnt;

				if (x.right === rb.EMPTY) {
					// last node
					const lineStartOffset = this.getOffsetAt(lfCnt + 1, 1);
					const column = originalOffset - offset - lineStartOffset;
					return new Position(lfCnt + 1, column + 1);
				} else {
					x = x.right;
				}
			}
		}

		return new Position(1, 1);
	}

	public getValueInRange(range: Range, eol?: string): string {
		if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) {
			return '';
		}

		const startPosition = this.nodeAt2(range.startLineNumber, range.startColumn);
		const endPosition = this.nodeAt2(range.endLineNumber, range.endColumn);

		const value = this.getValueInRange2(startPosition, endPosition);
		if (!eol || (eol === this._EOL && this._EOLNormalized)) {
			return value;
		}
		return value.replace(/\r\n|\r|\n/g, eol);
	}

	public getValueInRange2(startPosition: NodePosition, endPosition: NodePosition): string {
		const startNode = last(startPosition.path);
		const endNode = last(endPosition.path);
		const startPiece = startNode.value;
		const startOffset = buffers.offsetInBuffer(this._buffers, startPiece.bufferIndex, startPiece.start);
		const startBuffer = this._buffers[startPiece.bufferIndex].buffer;

		if (startNode === endNode) {
			return startBuffer.substring(startOffset + startPosition.remainder, startOffset + endPosition.remainder);
		}

		let ret = startBuffer.substring(startOffset + startPosition.remainder, startOffset + startPiece.length);
		const path = startPosition.path.slice();
		while (rb.next(path)) {
			const node = last(path);
			const piece = node.value;
			const buffer = this._buffers[piece.bufferIndex].buffer;
			const offset = buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.start);

			if (node === endNode) {
				ret += buffer.substring(offset, offset + endPosition.remainder);
				break;
			}
			ret += buffer.substr(offset, piece.length);
		}
		return ret;
	}

	public getLinesRawContent(): string {
		let ret = '';
		rb.forEach(this._root, piece => {
			ret += buffers.getPieceContent(this._buffers, piece);
		});
		return ret;
	}

	public getLinesContent(): string[] {
		return this.getLinesRawContent().split(/\r\n|\r|\n/);
	}

	/**
	 * @param lineNumber 1 based
	 */
	public getLineContent(lineNumber: number): string {
		if (this._lastVisitedLine.lineNumber === lineNumber) {
			return this._lastVisitedLine.value;
		}

		let value: string;
		if (lineNumber === this.getLineCount()) {
			value = this.getLineRawContent(lineNumber);
		} else if (this._EOLNormalized) {
			value = this.getLineRawContent(lineNumber, this._EOLLength);
		} else {
			value = this.getLineRawContent(lineNumber).replace(/(\r\n|\r|\n)$/, '');
		}
		// remembered only once known, so that a lookup that throws leaves no stale entry behind
		this._lastVisitedLine = { lineNumber, value };
		return value;
	}

	public getLineCharCode(lineNumber: number, index: number): number {
		const nodePos = this.nodeAt2(lineNumber, index + 1);
		let piece = last(nodePos.path).value;
		let remainder = nodePos.remainder;
		if (remainder === piece.length) {
			// the char we want to fetch is at the head of next node.
			const path = nodePos.path.slice();
			if (!rb.next(path)) {
				return 0;
			}
			piece = last(path).value;
			remainder = 0;
		}
		const buffer = this._buffers[piece.bufferIndex];
		const startOffset = buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.start);
		return buffer.buffer.charCodeAt(startOffset + remainder);
	}

	public getLineLength(lineNumber: number): number {
		if (lineNumber === this.getLineCount()) {
			const startOffset = this.getOffsetAt(lineNumber, 1);
			return this.getLength() - startOffset;
		}
		return this.getOffsetAt(lineNumber + 1, 1) - this.getOffsetAt(lineNumber, 1) - this._EOLLength;
	}

	// #endregion

	// #region Edits

	/**
	 * Inserts `value` at `offset`. `eolNormalized` says the text only contains
	 * the buffer's EOL; the flag is sticky, one unnormalized insert turns the
	 * EOL fast paths off for good, as in PieceTreeBase. An empty insert is a
	 * no-op, flag included (PieceTreeBase would store an empty piece), and so
	 * is a rejected one.
	 */
	public insert(offset: number, value: string, eolNormalized: boolean = false): void {
		this._checkRange(offset, 0);
		if (value.length === 0) {
			return;
		}
		this._EOLNormalized = this._EOLNormalized && eolNormalized;
		this._lastVisitedLine = { lineNumber: 0, value: '' };

		if (this._root === rb.EMPTY) {
			this._root = rb.fromValues(this._createNewPieces(value));
			return;
		}

		const position = rb.nodeAt(this._root, offset)!;
		const piece = last(position.path).value;
		const pieceStart = position.nodeStartOffset;
		const remainder = position.remainder;

		// Typing at the end of the piece that ends at the end of the change buffer: extend it.
		// Safe for the versions sharing the buffer: the piece's end equals the buffer's end only
		// if nothing was appended since the piece was made, so no other piece covers what is
		// appended now, and the extended piece exists only in the new root.
		if (piece.bufferIndex === 0
			&& piece.end.line === this._state.lastChangeBufferPos.line
			&& piece.end.column === this._state.lastChangeBufferPos.column
			&& pieceStart + piece.length === offset
			&& value.length < AverageBufferSize
			&& this._appendToPiece(pieceStart, piece, value)) {
			return;
		}

		if (pieceStart === offset) {
			this._insertBefore(pieceStart, piece, value);
		} else if (pieceStart + piece.length > offset) {
			this._insertInside(pieceStart, piece, remainder, value);
		} else {
			this._insertAfter(pieceStart, piece, value);
		}
	}

	public delete(offset: number, cnt: number): void {
		this._checkRange(offset, cnt);
		if (cnt === 0) {
			return;
		}
		this._lastVisitedLine = { lineNumber: 0, value: '' };

		const startPosition = rb.nodeAt(this._root, offset)!;
		const endPosition = rb.nodeAt(this._root, offset + cnt)!;
		const startNode = last(startPosition.path);
		const endNode = last(endPosition.path);
		const startPiece = startNode.value;
		const startStart = startPosition.nodeStartOffset;

		if (startNode === endNode) {
			const startSplit = buffers.positionInBuffer(this._buffers, startPiece, startPosition.remainder);
			const endSplit = buffers.positionInBuffer(this._buffers, startPiece, endPosition.remainder);

			if (startStart === offset) {
				if (cnt === startPiece.length) {
					// the whole piece goes; what followed it now meets what preceded it
					this._root = rb.removeAt(this._root, startStart);
					this._validateCRLFAt(startStart);
					return;
				}
				this._root = rb.replaceAt(this._root, startStart, this._pieceWithStart(startPiece, endSplit));
				this._validateCRLFAt(startStart);
				return;
			}

			if (startStart + startPiece.length === offset + cnt) {
				const shortened = this._pieceWithEnd(startPiece, startSplit);
				this._root = rb.replaceAt(this._root, startStart, shortened);
				this._validateCRLFAt(startStart + shortened.length);
				return;
			}

			// delete from the middle: the piece splits in two
			const left = this._pieceWithEnd(startPiece, startSplit);
			const right = this._pieceWithStart(startPiece, endSplit);
			this._root = rb.replaceAt(this._root, startStart, left);
			this._root = rb.insertAt(this._root, startStart + left.length, right);
			this._validateCRLFAt(startStart + left.length);
			return;
		}

		// the range spans several pieces: shorten the first and the last, drop the ones between
		const endPiece = endNode.value;
		const endStart = endPosition.nodeStartOffset;
		const left = this._pieceWithEnd(startPiece, buffers.positionInBuffer(this._buffers, startPiece, startPosition.remainder));
		const right = this._pieceWithStart(endPiece, buffers.positionInBuffer(this._buffers, endPiece, endPosition.remainder));

		// where the pieces in between start, read off the current tree before anything moves
		const between: number[] = [];
		const path = startPosition.path.slice();
		for (let at = startStart + startPiece.length; rb.next(path) && last(path) !== endNode; at += last(path).value.length) {
			between.push(at);
		}

		// right to left, so that the offsets of what is still to be done do not move
		let root = this._root;
		root = right.length === 0 ? rb.removeAt(root, endStart) : rb.replaceAt(root, endStart, right);
		for (let i = between.length - 1; i >= 0; i--) {
			root = rb.removeAt(root, between[i]);
		}
		root = left.length === 0 ? rb.removeAt(root, startStart) : rb.replaceAt(root, startStart, left);
		this._root = root;
		this._validateCRLFAt(startStart + left.length);
	}

	/** Rejects a range that is not a whole number of characters inside the document. */
	private _checkRange(offset: number, cnt: number): void {
		if (!Number.isInteger(offset) || !Number.isInteger(cnt) || offset < 0 || cnt < 0 || offset + cnt > this._root.size) {
			throw new RangeError(`range ${offset}..${offset + cnt} is not inside the document (length ${this._root.size})`);
		}
	}

	/** PieceTreeBase.appendToNode. Returns false when the append would need to rewrite the change buffer's line starts. */
	private _appendToPiece(pieceStart: number, piece: Piece, value: string): boolean {
		if (this._shouldCheckCRLF() && this._startWithLF(value) && this._endWithCR(piece)) {
			// a \n typed after a \r at the end of the change buffer: PieceTreeBase pops a line
			// start of the buffer here, which would change the meaning of pieces of older
			// versions; the general path joins the two into a \r\n piece instead
			return false;
		}
		if (this._pullLineFeedFromNext(pieceStart + piece.length, value)) {
			value += '\n';
		}

		const changeBuffer = this._buffers[0];
		const startOffset = changeBuffer.buffer.length;
		changeBuffer.buffer += value;
		const lineStarts = createLineStartsFast(value, false) as number[];
		for (let i = 0; i < lineStarts.length; i++) {
			lineStarts[i] += startOffset;
		}
		changeBuffer.lineStarts = (changeBuffer.lineStarts as number[]).concat(lineStarts.slice(1));
		const endIndex = changeBuffer.lineStarts.length - 1;
		const newEnd = { line: endIndex, column: changeBuffer.buffer.length - changeBuffer.lineStarts[endIndex] };
		const extended = new Piece(0, piece.start, newEnd, buffers.getLineFeedCnt(this._buffers, 0, piece.start, newEnd), piece.length + value.length);

		this._root = rb.replaceAt(this._root, pieceStart, extended);
		this._state.lastChangeBufferPos = newEnd;
		return true;
	}

	/** PieceTreeBase.insertContentToNodeLeft: `value` goes in front of the piece starting at `pieceStart`. */
	private _insertBefore(pieceStart: number, piece: Piece, value: string): void {
		if (this._shouldCheckCRLF() && this._endWithCR(value) && this._startWithLF(piece)) {
			// the piece's leading \n moves into the new text, to keep \r\n together
			const shortened = this._pieceWithStart(piece, { line: piece.start.line + 1, column: 0 });
			this._root = shortened.length === 0 ? rb.removeAt(this._root, pieceStart) : rb.replaceAt(this._root, pieceStart, shortened);
			value += '\n';
		}
		this._insertPieces(pieceStart, this._createNewPieces(value));
		this._validateCRLFAt(pieceStart);
	}

	/** PieceTreeBase.insertContentToNodeRight: `value` goes right after the piece starting at `pieceStart`. */
	private _insertAfter(pieceStart: number, piece: Piece, value: string): void {
		const at = pieceStart + piece.length;
		if (this._pullLineFeedFromNext(at, value)) {
			value += '\n';
		}
		this._insertPieces(at, this._createNewPieces(value));
		this._validateCRLFAt(at);
	}

	/** `value` goes into the middle of the piece starting at `pieceStart`, `remainder` characters in. */
	private _insertInside(pieceStart: number, piece: Piece, remainder: number, value: string): void {
		const insertPosInBuffer = buffers.positionInBuffer(this._buffers, piece, remainder);
		let right = this._pieceWithStart(piece, insertPosInBuffer);
		if (this._shouldCheckCRLF() && this._endWithCR(value) && this._charCodeAt(piece, remainder) === CharCode.LineFeed) {
			// the \n right after the insertion point moves into the new text
			right = this._pieceWithStart(right, { line: right.start.line + 1, column: 0 });
			value += '\n';
		}

		let left: Piece;
		if (this._shouldCheckCRLF() && this._startWithLF(value) && this._charCodeAt(piece, remainder - 1) === CharCode.CarriageReturn) {
			// the \r right before the insertion point moves into the new text
			left = this._pieceWithEnd(piece, buffers.positionInBuffer(this._buffers, piece, remainder - 1));
			value = '\r' + value;
		} else {
			left = this._pieceWithEnd(piece, insertPosInBuffer);
		}

		const newPieces = this._createNewPieces(value);
		this._root = left.length === 0 ? rb.removeAt(this._root, pieceStart) : rb.replaceAt(this._root, pieceStart, left);
		const at = this._insertPieces(pieceStart + left.length, newPieces);
		if (right.length > 0) {
			this._root = rb.insertAt(this._root, at, right);
		}
	}

	/** Inserts the pieces in order starting at `offset`; returns the offset after the last one. */
	private _insertPieces(offset: number, pieces: Piece[]): number {
		let at = offset;
		for (const piece of pieces) {
			this._root = rb.insertAt(this._root, at, piece);
			at += piece.length;
		}
		return at;
	}

	/**
	 * PieceTreeBase.adjustCarriageReturnFromNext: when `value` ends with \r and
	 * the piece starting at `offset` starts with \n, that \n is taken off the
	 * piece so that the caller can append it to `value`.
	 */
	private _pullLineFeedFromNext(offset: number, value: string): boolean {
		if (!this._shouldCheckCRLF() || !this._endWithCR(value)) {
			return false;
		}
		const next = this._pieceStartingAt(offset);
		if (next === null || !this._startWithLF(next)) {
			return false;
		}
		const shortened = this._pieceWithStart(next, { line: next.start.line + 1, column: 0 });
		this._root = shortened.length === 0 ? rb.removeAt(this._root, offset) : rb.replaceAt(this._root, offset, shortened);
		return true;
	}

	/**
	 * PieceTreeBase.validateCRLFWithPrevNode / validateCRLFWithNextNode: when
	 * the piece ending at `offset` ends with \r and the piece starting there
	 * starts with \n, the two are joined into one \r\n piece. Both of
	 * PieceTreeBase's variants come down to this check at the boundary they
	 * are given a side of.
	 */
	private _validateCRLFAt(offset: number): void {
		if (!this._shouldCheckCRLF()) {
			return;
		}
		const next = this._pieceStartingAt(offset);
		const prev = this._pieceEndingAt(offset);
		if (next !== null && prev !== null && this._startWithLF(next) && this._endWithCR(prev)) {
			this._fixCRLF(offset, prev, next);
		}
	}

	/**
	 * PieceTreeBase.fixCRLF: `prev` ends with \r at `offset`, `next` starts
	 * with \n there. Both lose that character and a new \r\n piece goes between
	 * them, so that no line break is split across pieces.
	 */
	private _fixCRLF(offset: number, prev: Piece, next: Piece): void {
		const lineStarts = this._buffers[prev.bufferIndex].lineStarts;
		let prevEnd: BufferCursor;
		if (prev.end.column === 0) {
			// the piece's last line ends with a lone \r
			prevEnd = { line: prev.end.line - 1, column: lineStarts[prev.end.line] - lineStarts[prev.end.line - 1] - 1 };
		} else {
			// the \r is the first half of a \r\n in the buffer
			prevEnd = { line: prev.end.line, column: prev.end.column - 1 };
		}
		const shortenedPrev = new Piece(prev.bufferIndex, prev.start, prevEnd, prev.lineFeedCnt - 1, prev.length - 1);
		const shortenedNext = this._pieceWithStart(next, { line: next.start.line + 1, column: 0 });
		const crlf = this._createNewPieces('\r\n')[0];

		let root = this._root;
		root = shortenedNext.length === 0 ? rb.removeAt(root, offset) : rb.replaceAt(root, offset, shortenedNext);
		root = shortenedPrev.length === 0 ? rb.removeAt(root, offset - prev.length) : rb.replaceAt(root, offset - prev.length, shortenedPrev);
		root = rb.insertAt(root, offset - 1, crlf);
		this._root = root;
	}

	/**
	 * PieceTreeBase.createNewPieces: stores `text` and returns the pieces for
	 * it. Text of up to AverageBufferSize characters is appended to the change
	 * buffer, longer text gets buffers of its own, cut so that no \r\n or
	 * surrogate pair is split.
	 */
	private _createNewPieces(text: string): Piece[] {
		const bufferList = this._buffers;
		if (text.length > AverageBufferSize) {
			const newPieces: Piece[] = [];
			while (text.length > AverageBufferSize) {
				const lastChar = text.charCodeAt(AverageBufferSize - 1);
				let splitText;
				if (lastChar === CharCode.CarriageReturn || (lastChar >= 0xD800 && lastChar <= 0xDBFF)) {
					// last character is \r or a high surrogate => keep it back
					splitText = text.substring(0, AverageBufferSize - 1);
					text = text.substring(AverageBufferSize - 1);
				} else {
					splitText = text.substring(0, AverageBufferSize);
					text = text.substring(AverageBufferSize);
				}
				newPieces.push(this._wholeBufferPiece(splitText));
			}
			newPieces.push(this._wholeBufferPiece(text));
			return newPieces;
		}

		const changeBuffer = bufferList[0];
		let startOffset = changeBuffer.buffer.length;
		const lineStarts = createLineStartsFast(text, false) as number[];

		let start = this._state.lastChangeBufferPos;
		if (changeBuffer.lineStarts[changeBuffer.lineStarts.length - 1] === startOffset
			&& startOffset !== 0
			&& this._startWithLF(text)
			&& this._endWithCR(changeBuffer.buffer)
		) {
			// a filler character keeps the \n from forming a \r\n with the buffer's last character
			this._state.lastChangeBufferPos = { line: start.line, column: start.column + 1 };
			start = this._state.lastChangeBufferPos;

			for (let i = 0; i < lineStarts.length; i++) {
				lineStarts[i] += startOffset + 1;
			}

			changeBuffer.lineStarts = (changeBuffer.lineStarts as number[]).concat(lineStarts.slice(1));
			changeBuffer.buffer += '_' + text;
			startOffset += 1;
		} else {
			if (startOffset !== 0) {
				for (let i = 0; i < lineStarts.length; i++) {
					lineStarts[i] += startOffset;
				}
			}
			changeBuffer.lineStarts = (changeBuffer.lineStarts as number[]).concat(lineStarts.slice(1));
			changeBuffer.buffer += text;
		}

		const endOffset = changeBuffer.buffer.length;
		const endIndex = changeBuffer.lineStarts.length - 1;
		const endPos = { line: endIndex, column: endOffset - changeBuffer.lineStarts[endIndex] };
		const newPiece = new Piece(0, start, endPos, buffers.getLineFeedCnt(bufferList, 0, start, endPos), endOffset - startOffset);
		this._state.lastChangeBufferPos = endPos;
		return [newPiece];
	}

	/** A new read-only buffer holding exactly `text`, and the piece covering all of it. */
	private _wholeBufferPiece(text: string): Piece {
		const lineStarts = createLineStartsFast(text);
		const piece = new Piece(
			this._buffers.length,
			{ line: 0, column: 0 },
			{ line: lineStarts.length - 1, column: text.length - lineStarts[lineStarts.length - 1] },
			lineStarts.length - 1,
			text.length
		);
		this._buffers.push(new StringBuffer(text, lineStarts));
		return piece;
	}

	/** PieceTreeBase.deleteNodeTail: `piece` cut at `end`. */
	private _pieceWithEnd(piece: Piece, end: BufferCursor): Piece {
		const length = piece.length + buffers.offsetInBuffer(this._buffers, piece.bufferIndex, end) - buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.end);
		return new Piece(piece.bufferIndex, piece.start, end, buffers.getLineFeedCnt(this._buffers, piece.bufferIndex, piece.start, end), length);
	}

	/** PieceTreeBase.deleteNodeHead: `piece` starting at `start` instead. */
	private _pieceWithStart(piece: Piece, start: BufferCursor): Piece {
		const length = piece.length - (buffers.offsetInBuffer(this._buffers, piece.bufferIndex, start) - buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.start));
		return new Piece(piece.bufferIndex, start, piece.end, buffers.getLineFeedCnt(this._buffers, piece.bufferIndex, start, piece.end), length);
	}

	/** The piece that starts exactly at `offset`, or null when no piece boundary is there. */
	private _pieceStartingAt(offset: number): Piece | null {
		if (offset >= this._root.size) {
			return null;
		}
		const position = rb.nodeAt(this._root, offset)!;
		const piece = last(position.path).value;
		if (position.remainder === 0) {
			return piece;
		}
		if (position.remainder === piece.length) {
			// the descent stopped at the piece ending here; the one starting here is its successor
			return rb.next(position.path) ? last(position.path).value : null;
		}
		return null;
	}

	/** The piece that ends exactly at `offset`, or null when no piece boundary is there. */
	private _pieceEndingAt(offset: number): Piece | null {
		if (offset <= 0) {
			return null;
		}
		const position = rb.nodeAt(this._root, offset)!;
		const piece = last(position.path).value;
		if (position.remainder === piece.length) {
			return piece;
		}
		if (position.remainder === 0) {
			return rb.prev(position.path) ? last(position.path).value : null;
		}
		return null;
	}

	private _shouldCheckCRLF(): boolean {
		return !(this._EOLNormalized && this._EOL === '\n');
	}

	private _startWithLF(val: string | Piece): boolean {
		if (typeof val === 'string') {
			return val.charCodeAt(0) === CharCode.LineFeed;
		}
		if (val.lineFeedCnt === 0) {
			return false;
		}
		const lineStarts = this._buffers[val.bufferIndex].lineStarts;
		const line = val.start.line;
		const startOffset = lineStarts[line] + val.start.column;
		if (line === lineStarts.length - 1) {
			// last line, so there is no line feed at the end of this line
			return false;
		}
		if (lineStarts[line + 1] > startOffset + 1) {
			return false;
		}
		return this._buffers[val.bufferIndex].buffer.charCodeAt(startOffset) === CharCode.LineFeed;
	}

	private _endWithCR(val: string | Piece): boolean {
		if (typeof val === 'string') {
			return val.charCodeAt(val.length - 1) === CharCode.CarriageReturn;
		}
		if (val.lineFeedCnt === 0) {
			return false;
		}
		return this._charCodeAt(val, val.length - 1) === CharCode.CarriageReturn;
	}

	/** PieceTreeBase.nodeCharCodeAt: -1 for a piece without line feeds. */
	private _charCodeAt(piece: Piece, offset: number): number {
		if (piece.lineFeedCnt < 1) {
			return -1;
		}
		return this._buffers[piece.bufferIndex].buffer.charCodeAt(buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.start) + offset);
	}

	// #endregion

	// #region Lookups

	/**
	 * The piece containing `offset`. As in PieceTreeBase, an offset at the very
	 * end of a piece is reported as that piece with `remainder` equal to its
	 * length when the descent reaches it first.
	 */
	public nodeAt(offset: number): NodePosition {
		const position = rb.nodeAt(this._root, offset);
		if (position === null) {
			throw new RangeError(`offset ${offset} is outside the document`);
		}
		return position;
	}

	/**
	 * The piece in which line `lineNumber` (1-based) starts, or null past the
	 * last line. The descent stops at the first piece whose line feeds reach
	 * the line; when the line starts right after a piece's last line feed, the
	 * piece before the line is reported, with the line starting at its end.
	 */
	private _descendToLine(lineNumber: number): rb.DescentPosition<Piece> | null {
		return rb.descend(this._root, (node, _nodeStartOffset, nodeStartLf) => {
			if (node.left !== rb.EMPTY && nodeStartLf >= lineNumber - 1) {
				return -1;
			}
			if (nodeStartLf + node.value.lineFeedCnt >= lineNumber - 1) {
				return 0;
			}
			return 1;
		});
	}

	/** The piece containing the character at `lineNumber`/`column` (1-based); the column may point just past the line. */
	public nodeAt2(lineNumber: number, column: number): NodePosition {
		const position = this._descendToLine(lineNumber);
		if (position === null) {
			throw new RangeError(`line ${lineNumber} is outside the document`);
		}

		const { path, nodeStartOffset, nodeStartLf } = position;
		const piece = last(path).value;
		const prevAccumulatedValue = buffers.getAccumulatedValue(this._buffers, piece, lineNumber - nodeStartLf - 2);

		if (nodeStartLf + piece.lineFeedCnt > lineNumber - 1) {
			// the line ends inside this piece
			const accumulatedValue = buffers.getAccumulatedValue(this._buffers, piece, lineNumber - nodeStartLf - 1);
			return { path, remainder: Math.min(prevAccumulatedValue + column - 1, accumulatedValue), nodeStartOffset };
		}

		// the line starts in this piece and runs on into the following ones
		if (prevAccumulatedValue + column - 1 <= piece.length) {
			return { path, remainder: prevAccumulatedValue + column - 1, nodeStartOffset };
		}
		column -= piece.length - prevAccumulatedValue;

		let startOffset = nodeStartOffset + piece.length;
		while (rb.next(path)) {
			const next = last(path).value;
			if (next.lineFeedCnt > 0) {
				const accumulatedValue = buffers.getAccumulatedValue(this._buffers, next, 0);
				return { path, remainder: Math.min(column - 1, accumulatedValue), nodeStartOffset: startOffset };
			}
			if (next.length >= column - 1) {
				return { path, remainder: column - 1, nodeStartOffset: startOffset };
			}
			column -= next.length;
			startOffset += next.length;
		}
		throw new RangeError(`column ${column} is outside line ${lineNumber}`);
	}

	/** The raw content of a line, including its line break unless `endOffset` characters are cut off the end. */
	public getLineRawContent(lineNumber: number, endOffset: number = 0): string {
		let ret = '';
		let path: Path;

		const cache = this._lineCache;
		if (cache !== null && cache.root === this._root
			&& cache.nodeStartLineNumber < lineNumber && cache.nodeStartLineNumber + last(cache.path).value.lineFeedCnt >= lineNumber) {
			path = cache.path.slice();
			const piece = last(path).value;
			const prevAccumulatedValue = buffers.getAccumulatedValue(this._buffers, piece, lineNumber - cache.nodeStartLineNumber - 1);
			const buffer = this._buffers[piece.bufferIndex].buffer;
			const startOffset = buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.start);
			if (cache.nodeStartLineNumber + piece.lineFeedCnt === lineNumber) {
				ret = buffer.substring(startOffset + prevAccumulatedValue, startOffset + piece.length);
			} else {
				const accumulatedValue = buffers.getAccumulatedValue(this._buffers, piece, lineNumber - cache.nodeStartLineNumber);
				return buffer.substring(startOffset + prevAccumulatedValue, startOffset + accumulatedValue - endOffset);
			}
		} else {
			const position = this._descendToLine(lineNumber);
			if (position === null) {
				return '';
			}
			path = position.path;
			const piece = last(path).value;
			const prevAccumulatedValue = buffers.getAccumulatedValue(this._buffers, piece, lineNumber - position.nodeStartLf - 2);
			const buffer = this._buffers[piece.bufferIndex].buffer;
			const startOffset = buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.start);

			if (position.nodeStartLf + piece.lineFeedCnt > lineNumber - 1) {
				// the line ends inside this piece; remember the piece for the lines that follow
				const accumulatedValue = buffers.getAccumulatedValue(this._buffers, piece, lineNumber - position.nodeStartLf - 1);
				this._lineCache = { root: this._root, path: path.slice(), nodeStartLineNumber: position.nodeStartLf + 1 };
				return buffer.substring(startOffset + prevAccumulatedValue, startOffset + accumulatedValue - endOffset);
			}
			// the line starts in this piece and runs on into the following ones
			ret = buffer.substring(startOffset + prevAccumulatedValue, startOffset + piece.length);
		}

		while (rb.next(path)) {
			const piece = last(path).value;
			const buffer = this._buffers[piece.bufferIndex].buffer;
			const startOffset = buffers.offsetInBuffer(this._buffers, piece.bufferIndex, piece.start);

			if (piece.lineFeedCnt > 0) {
				const accumulatedValue = buffers.getAccumulatedValue(this._buffers, piece, 0);
				ret += buffer.substring(startOffset, startOffset + accumulatedValue - endOffset);
				return ret;
			}
			ret += buffer.substr(startOffset, piece.length);
		}

		return ret;
	}

	// #endregion
}
