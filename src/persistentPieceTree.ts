import { Position } from './common/position';
import { Range } from './common/range';
import * as rb from './persistentRbTree';
import * as buffers from './pieceBuffers';
import { Piece, StringBuffer, createLineStartsFast } from './pieceBuffers';
import { ITextSnapshot } from './pieceTreeBase';

/*
 * The piece tree on the persistent red-black tree: the same text buffer as
 * PieceTreeBase, with a root that is never modified. This is the read side;
 * the edits and the versions they produce follow.
 *
 * The lookups are PieceTreeBase's algorithms (VS Code, MIT) restated for a
 * tree without parent pointers: a descent from the root records its path,
 * and the path is what walks to the neighbouring pieces afterwards. The
 * metadata is per subtree rather than per left subtree, which turns
 * PieceTreeBase's running subtractions into absolute offsets and line counts
 * handed to the descent callback.
 */

type Node = rb.Node<Piece>;
type Path = rb.Path<Piece>;

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
 * The most recent lookup, reused when the next one lands in the same piece
 * (reading consecutive lines does this all the time). Tied to the root it was
 * taken from, since a path into another version is meaningless here.
 */
interface CacheEntry {
	readonly root: Node;
	readonly path: Path;
	readonly nodeStartOffset: number;
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
	private _root: Node;
	/** Index 0 is the change buffer (for the edits to come); the others are the read-only original chunks. */
	private readonly _buffers: StringBuffer[];
	private readonly _EOL: '\r\n' | '\n';
	private readonly _EOLLength: number;
	private readonly _EOLNormalized: boolean;
	private _lastVisitedLine: { lineNumber: number; value: string };
	private _cache: CacheEntry | null;

	constructor(chunks: StringBuffer[], eol: '\r\n' | '\n', eolNormalized: boolean) {
		this._buffers = [new StringBuffer('', [0])];
		this._EOL = eol;
		this._EOLLength = eol.length;
		this._EOLNormalized = eolNormalized;
		this._lastVisitedLine = { lineNumber: 0, value: '' };
		this._cache = null;

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

	// #region Buffer API

	public getEOL(): '\r\n' | '\n' {
		return this._EOL;
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

		this._lastVisitedLine.lineNumber = lineNumber;

		if (lineNumber === this.getLineCount()) {
			this._lastVisitedLine.value = this.getLineRawContent(lineNumber);
		} else if (this._EOLNormalized) {
			this._lastVisitedLine.value = this.getLineRawContent(lineNumber, this._EOLLength);
		} else {
			this._lastVisitedLine.value = this.getLineRawContent(lineNumber).replace(/(\r\n|\r|\n)$/, '');
		}

		return this._lastVisitedLine.value;
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

	// #region Lookups

	/**
	 * The piece containing `offset`. As in PieceTreeBase, an offset at the very
	 * end of a piece is reported as that piece with `remainder` equal to its
	 * length when the descent reaches it first.
	 */
	nodeAt(offset: number): NodePosition {
		const cache = this._cache;
		if (cache !== null && cache.root === this._root) {
			const piece = last(cache.path).value;
			if (cache.nodeStartOffset <= offset && offset <= cache.nodeStartOffset + piece.length) {
				return { path: cache.path.slice(), nodeStartOffset: cache.nodeStartOffset, remainder: offset - cache.nodeStartOffset };
			}
		}

		const position = rb.nodeAt(this._root, offset);
		if (position === null) {
			throw new RangeError(`offset ${offset} is outside the document`);
		}
		this._cache = { root: this._root, path: position.path.slice(), nodeStartOffset: position.nodeStartOffset, nodeStartLineNumber: 0 };
		return position;
	}

	/** The piece containing the character at `lineNumber`/`column` (1-based); the column may point just past the line. */
	nodeAt2(lineNumber: number, column: number): NodePosition {
		const position = rb.descend(this._root, (node, _nodeStartOffset, nodeStartLf) => {
			if (node.left !== rb.EMPTY && nodeStartLf >= lineNumber - 1) {
				return -1;
			}
			if (nodeStartLf + node.value.lineFeedCnt >= lineNumber - 1) {
				return 0;
			}
			return 1;
		});
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
	getLineRawContent(lineNumber: number, endOffset: number = 0): string {
		let ret = '';
		let path: Path;

		const cache = this._cache;
		if (cache !== null && cache.root === this._root && cache.nodeStartLineNumber > 0
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
			const position = rb.descend(this._root, (node, _nodeStartOffset, nodeStartLf) => {
				if (node.left !== rb.EMPTY && nodeStartLf >= lineNumber - 1) {
					return -1;
				}
				if (nodeStartLf + node.value.lineFeedCnt >= lineNumber - 1) {
					return 0;
				}
				return 1;
			});
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
				this._cache = { root: this._root, path: path.slice(), nodeStartOffset: position.nodeStartOffset, nodeStartLineNumber: position.nodeStartLf + 1 };
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
