/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CharCode } from './common/charCode';

/*
 * The layer below the tree: the text buffers, the pieces that reference them,
 * and the arithmetic between a piece and its buffer (offset <-> line/column
 * cursor, line feeds in a range, content of a piece). Nothing here knows about
 * tree nodes, so both the mutable piece tree and the persistent one use it.
 */

/**
 * Text below this size goes into the change buffer; larger inserts get
 * buffers of their own, and a document is re-chunked into buffers of about
 * this size when its line endings are normalized.
 */
export const AverageBufferSize = 65535;

export function createUintArray(arr: number[]): Uint32Array {
	const r = new Uint32Array(arr.length);
	r.set(arr, 0);
	return r;
}

export class LineStarts {
	constructor(
		public readonly lineStarts: Uint32Array,
		public readonly cr: number,
		public readonly lf: number,
		public readonly crlf: number,
		public readonly isBasicASCII: boolean
	) { }
}

function scanLineStarts(str: string, r: number[]): number {
	let rLength = 1;
	r[0] = 0;
	const len = str.length;

	// V8's indexOf is SIMD-backed. For the common LF-only case (normalized
	// buffers, Unix files) that is much faster than a charCodeAt loop. A file
	// that still has CR pays one indexOf('\r') then falls back.
	if (str.indexOf('\r') === -1) {
		let i = 0;
		while ((i = str.indexOf('\n', i)) !== -1) {
			r[rLength++] = ++i;
		}
	} else {
		for (let i = 0; i < len; i++) {
			const chr = str.charCodeAt(i);

			if (chr === CharCode.CarriageReturn) {
				if (i + 1 < len && str.charCodeAt(i + 1) === CharCode.LineFeed) {
					r[rLength++] = i + 2;
					i++; // skip \n
				} else {
					r[rLength++] = i + 1;
				}
			} else if (chr === CharCode.LineFeed) {
				r[rLength++] = i + 1;
			}
		}
	}
	return rLength;
}

export function createLineStartsFast(str: string, readonly: boolean = true): Uint32Array | number[] {
	const r: number[] = [0];
	const rLength = scanLineStarts(str, r);
	if (!readonly) {
		r.length = rLength;
		return r;
	}
	const arr = new Uint32Array(rLength);
	for (let i = 0; i < rLength; i++) {
		arr[i] = r[i];
	}
	return arr;
}

export function createLineStarts(r: number[], str: string): LineStarts {
	const rLength = scanLineStarts(str, r);
	let cr = 0, lf = 0, crlf = 0;
	for (let i = 0, len = str.length; i < len; i++) {
		const chr = str.charCodeAt(i);
		if (chr === CharCode.CarriageReturn) {
			if (i + 1 < len && str.charCodeAt(i + 1) === CharCode.LineFeed) {
				crlf++;
				i++;
			} else {
				cr++;
			}
		} else if (chr === CharCode.LineFeed) {
			lf++;
		}
	}
	const lineStarts = new Uint32Array(rLength);
	for (let i = 0; i < rLength; i++) {
		lineStarts[i] = r[i];
	}
	r.length = 0;
	return new LineStarts(lineStarts, cr, lf, crlf, true);
}

export interface BufferCursor {
	/**
	 * Line number in current buffer
	 */
	line: number;
	/**
	 * Column number in current buffer
	 */
	column: number;
}

export class Piece {
	readonly bufferIndex: number;
	readonly start: BufferCursor;
	readonly end: BufferCursor;
	readonly length: number;
	readonly lineFeedCnt: number;

	constructor(bufferIndex: number, start: BufferCursor, end: BufferCursor, lineFeedCnt: number, length: number) {
		this.bufferIndex = bufferIndex;
		this.start = start;
		this.end = end;
		this.lineFeedCnt = lineFeedCnt;
		this.length = length;
	}
}

export class StringBuffer {
	buffer: string;
	lineStarts: Uint32Array | number[];
	/** Used entries in `lineStarts`; may be less than `lineStarts.length` for a growable change buffer. */
	lineStartsCount: number;

	constructor(buffer: string, lineStarts: Uint32Array | number[] | undefined, lineStartsCount?: number) {
		this.buffer = buffer;
		this.lineStarts = lineStarts ?? [];
		this.lineStartsCount = lineStartsCount ?? this.lineStarts.length;
	}
}

export function offsetInBuffer(buffers: StringBuffer[], bufferIndex: number, cursor: BufferCursor): number {
	const lineStarts = buffers[bufferIndex].lineStarts;
	return lineStarts[cursor.line] + cursor.column;
}

/** The buffer cursor `remainder` characters into `piece`, found by binary search over the piece's line starts. */
export function positionInBuffer(buffers: StringBuffer[], piece: Piece, remainder: number): BufferCursor {
	const lineStarts = buffers[piece.bufferIndex].lineStarts;

	const startOffset = lineStarts[piece.start.line] + piece.start.column;

	const offset = startOffset + remainder;

	// binary search offset between startOffset and endOffset
	let low = piece.start.line;
	let high = piece.end.line;

	let mid: number = 0;
	let midStop: number = 0;
	let midStart: number = 0;

	while (low <= high) {
		mid = low + ((high - low) / 2) | 0;
		midStart = lineStarts[mid];

		if (mid === high) {
			break;
		}

		midStop = lineStarts[mid + 1];

		if (offset < midStart) {
			high = mid - 1;
		} else if (offset >= midStop) {
			low = mid + 1;
		} else {
			break;
		}
	}

	return {
		line: mid,
		column: offset - midStart
	};
}

export function getLineFeedCnt(buffers: StringBuffer[], bufferIndex: number, start: BufferCursor, end: BufferCursor): number {
	// we don't need to worry about start: abc\r|\n, or abc|\r, or abc|\n, or abc|\r\n doesn't change the fact that, there is one line break after start.
	// now let's take care of end: abc\r|\n, if end is in between \r and \n, we need to add line feed count by 1
	if (end.column === 0) {
		return end.line - start.line;
	}

	const buf = buffers[bufferIndex];
	const lineStarts = buf.lineStarts;
	if (end.line === buf.lineStartsCount - 1) { // it means, there is no \n after end, otherwise, there will be one more lineStart.
		return end.line - start.line;
	}

	const nextLineStartOffset = lineStarts[end.line + 1];
	const endOffset = lineStarts[end.line] + end.column;
	if (nextLineStartOffset > endOffset + 1) { // there are more than 1 character after end, which means it can't be \n
		return end.line - start.line;
	}
	// endOffset + 1 === nextLineStartOffset
	// character at endOffset is \n, so we check the character before first
	// if character at endOffset is \r, end.column is 0 and we can't get here.
	const previousCharOffset = endOffset - 1; // end.column > 0 so it's okay.
	const buffer = buffers[bufferIndex].buffer;

	if (buffer.charCodeAt(previousCharOffset) === 13) {
		return end.line - start.line + 1;
	} else {
		return end.line - start.line;
	}
}

/**
 * Offset within `piece` at which its line `index + 1` starts (0 for a negative
 * index); the piece's length when the piece has no such line.
 */
export function getAccumulatedValue(buffers: StringBuffer[], piece: Piece, index: number): number {
	if (index < 0) {
		return 0;
	}
	const lineStarts = buffers[piece.bufferIndex].lineStarts;
	const expectedLineStartIndex = piece.start.line + index + 1;
	if (expectedLineStartIndex > piece.end.line) {
		return lineStarts[piece.end.line] + piece.end.column - lineStarts[piece.start.line] - piece.start.column;
	} else {
		return lineStarts[expectedLineStartIndex] - lineStarts[piece.start.line] - piece.start.column;
	}
}

/** Line index within `piece` and column within that line of the character `accumulatedValue` characters into the piece. */
export function getIndexOf(buffers: StringBuffer[], piece: Piece, accumulatedValue: number): { index: number; remainder: number } {
	const pos = positionInBuffer(buffers, piece, accumulatedValue);
	const lineCnt = pos.line - piece.start.line;

	if (offsetInBuffer(buffers, piece.bufferIndex, piece.end) - offsetInBuffer(buffers, piece.bufferIndex, piece.start) === accumulatedValue) {
		// we are checking the end of this node, so a CRLF check is necessary.
		const realLineCnt = getLineFeedCnt(buffers, piece.bufferIndex, piece.start, pos);
		if (realLineCnt !== lineCnt) {
			// aha yes, CRLF
			return { index: realLineCnt, remainder: 0 };
		}
	}

	return { index: lineCnt, remainder: pos.column };
}

export function getPieceContent(buffers: StringBuffer[], piece: Piece): string {
	const buffer = buffers[piece.bufferIndex];
	const startOffset = offsetInBuffer(buffers, piece.bufferIndex, piece.start);
	const endOffset = offsetInBuffer(buffers, piece.bufferIndex, piece.end);
	return buffer.buffer.substring(startOffset, endOffset);
}
