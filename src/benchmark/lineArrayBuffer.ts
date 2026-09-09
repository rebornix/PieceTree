import { startsWithUTF8BOM } from '../pieceTreeBuilder';

/*
 * The "line array" text buffer: one string per line plus a prefix sum of line
 * lengths for offset <-> position conversion. This is what VS Code used before
 * the piece tree and the baseline of the comparisons in
 * https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation;
 * it is a compact port of the parts of LinesTextBuffer and PrefixSumComputer
 * (VS Code 1.21) that the benchmark workloads exercise.
 */

export interface IEditRange {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

/** Result of an edit: what TextModel puts in the content-change event and the undo stack. */
export interface IAppliedEdit {
	rangeOffset: number;
	rangeLength: number;
	/** The text the edit replaced (the reverse operation's text). */
	oldText: string;
}

const EOL_REGEX = /\r\n|\r|\n/;

/**
 * Prefix sums over line lengths, recomputed lazily from the first changed
 * line on the next query (vs/editor/common/viewModel/prefixSumComputer.ts).
 */
export class PrefixSumComputer {
	private values: Uint32Array;
	private prefixSum: Uint32Array;
	private prefixSumValidIndex: number;

	constructor(values: Uint32Array) {
		this.values = values;
		this.prefixSum = new Uint32Array(values.length);
		this.prefixSumValidIndex = -1;
	}

	insertValues(insertIndex: number, insertValues: Uint32Array): void {
		const oldValues = this.values;
		const oldPrefixSum = this.prefixSum;
		const insertValuesLen = insertValues.length;
		if (insertValuesLen === 0) {
			return;
		}
		this.values = new Uint32Array(oldValues.length + insertValuesLen);
		this.values.set(oldValues.subarray(0, insertIndex), 0);
		this.values.set(oldValues.subarray(insertIndex), insertIndex + insertValuesLen);
		this.values.set(insertValues, insertIndex);

		if (insertIndex - 1 < this.prefixSumValidIndex) {
			this.prefixSumValidIndex = insertIndex - 1;
		}
		this.prefixSum = new Uint32Array(this.values.length);
		if (this.prefixSumValidIndex >= 0) {
			this.prefixSum.set(oldPrefixSum.subarray(0, this.prefixSumValidIndex + 1));
		}
	}

	changeValue(index: number, value: number): void {
		if (this.values[index] === value) {
			return;
		}
		this.values[index] = value;
		if (index - 1 < this.prefixSumValidIndex) {
			this.prefixSumValidIndex = index - 1;
		}
	}

	removeValues(startIndex: number, cnt: number): void {
		const oldValues = this.values;
		const oldPrefixSum = this.prefixSum;
		if (startIndex >= oldValues.length) {
			return;
		}
		cnt = Math.min(cnt, oldValues.length - startIndex);
		if (cnt === 0) {
			return;
		}
		this.values = new Uint32Array(oldValues.length - cnt);
		this.values.set(oldValues.subarray(0, startIndex), 0);
		this.values.set(oldValues.subarray(startIndex + cnt), startIndex);

		this.prefixSum = new Uint32Array(this.values.length);
		if (startIndex - 1 < this.prefixSumValidIndex) {
			this.prefixSumValidIndex = startIndex - 1;
		}
		if (this.prefixSumValidIndex >= 0) {
			this.prefixSum.set(oldPrefixSum.subarray(0, this.prefixSumValidIndex + 1));
		}
	}

	getTotalValue(): number {
		if (this.values.length === 0) {
			return 0;
		}
		return this.getAccumulatedValue(this.values.length - 1);
	}

	getAccumulatedValue(index: number): number {
		if (index < 0) {
			return 0;
		}
		if (index <= this.prefixSumValidIndex) {
			return this.prefixSum[index];
		}
		let startIndex = this.prefixSumValidIndex + 1;
		if (startIndex === 0) {
			this.prefixSum[0] = this.values[0];
			startIndex++;
		}
		if (index >= this.values.length) {
			index = this.values.length - 1;
		}
		for (let i = startIndex; i <= index; i++) {
			this.prefixSum[i] = this.prefixSum[i - 1] + this.values[i];
		}
		this.prefixSumValidIndex = Math.max(this.prefixSumValidIndex, index);
		return this.prefixSum[index];
	}

	/** Index of the value containing `accumulatedValue`, and the remainder inside it. */
	getIndexOf(accumulatedValue: number): { index: number; remainder: number } {
		this.getTotalValue();
		let low = 0;
		let high = this.values.length - 1;
		let mid = 0;
		let midStart = 0;
		while (low <= high) {
			mid = low + ((high - low) / 2) | 0;
			const midStop = this.prefixSum[mid];
			midStart = midStop - this.values[mid];
			if (accumulatedValue < midStart) {
				high = mid - 1;
			} else if (accumulatedValue >= midStop) {
				low = mid + 1;
			} else {
				break;
			}
		}
		return { index: mid, remainder: accumulatedValue - midStart };
	}
}

export class LineArrayBuffer {
	private _lines: string[];
	private readonly _EOL: '\r\n' | '\n';
	private _lineStarts!: PrefixSumComputer;

	constructor(lines: string[], eol: '\r\n' | '\n') {
		this._lines = lines;
		this._EOL = eol;
		this._constructLineStarts();
	}

	private _constructLineStarts(): void {
		const eolLength = this._EOL.length;
		const linesLength = this._lines.length;
		const lineStartValues = new Uint32Array(linesLength);
		for (let i = 0; i < linesLength; i++) {
			lineStartValues[i] = this._lines[i].length + eolLength;
		}
		this._lineStarts = new PrefixSumComputer(lineStartValues);
	}

	getEOL(): '\r\n' | '\n' {
		return this._EOL;
	}

	getLineCount(): number {
		return this._lines.length;
	}

	getLineContent(lineNumber: number): string {
		return this._lines[lineNumber - 1];
	}

	forEachLine(callback: (line: string) => void): void {
		const lines = this._lines;
		for (let i = 0; i < lines.length; i++) {
			callback(lines[i]);
		}
	}

	getLength(): number {
		return this._lineStarts.getTotalValue();
	}

	getOffsetAt(lineNumber: number, column: number): number {
		return this._lineStarts.getAccumulatedValue(lineNumber - 2) + column - 1;
	}

	getPositionAt(offset: number): { lineNumber: number; column: number } {
		offset = Math.min(Math.max(0, Math.floor(offset)), this.getLength());
		const out = this._lineStarts.getIndexOf(offset);
		const lineNumber = out.index + 1;
		const column = Math.min(out.remainder + 1, this._lines[out.index].length + 1);
		return { lineNumber, column };
	}

	getValueInRange(range: IEditRange): string {
		if (range.startLineNumber === range.endLineNumber) {
			return this._lines[range.startLineNumber - 1].substring(range.startColumn - 1, range.endColumn - 1);
		}
		const parts = [this._lines[range.startLineNumber - 1].substring(range.startColumn - 1)];
		for (let i = range.startLineNumber; i < range.endLineNumber - 1; i++) {
			parts.push(this._lines[i]);
		}
		parts.push(this._lines[range.endLineNumber - 1].substring(0, range.endColumn - 1));
		return parts.join(this._EOL);
	}

	getValueLengthInRange(range: IEditRange): number {
		if (range.startLineNumber === range.endLineNumber) {
			return range.endColumn - range.startColumn;
		}
		return this.getOffsetAt(range.endLineNumber, range.endColumn) - this.getOffsetAt(range.startLineNumber, range.startColumn);
	}

	getValue(): string {
		return this._lines.join(this._EOL);
	}

	/**
	 * LinesTextBuffer.applyEdits for a single operation: compute what the
	 * content-change event and the undo stack need, then update the lines and
	 * the prefix sums (_doApplyEdits).
	 */
	applyEdit(range: IEditRange, text: string): IAppliedEdit {
		const rangeOffset = this.getOffsetAt(range.startLineNumber, range.startColumn);
		const rangeLength = this.getValueLengthInRange(range);
		const oldText = rangeLength === 0 ? '' : this.getValueInRange(range);
		const lines = text.length > 0 ? text.split(EOL_REGEX) : null;

		const startLineNumber = range.startLineNumber;
		const startColumn = range.startColumn;
		const endLineNumber = range.endLineNumber;
		const endColumn = range.endColumn;

		if (rangeLength === 0 && lines === null) {
			return { rangeOffset, rangeLength, oldText };
		}

		const deletingLinesCnt = endLineNumber - startLineNumber;
		const insertingLinesCnt = (lines ? lines.length - 1 : 0);
		const editingLinesCnt = Math.min(deletingLinesCnt, insertingLinesCnt);

		for (let j = editingLinesCnt; j >= 0; j--) {
			const editLineNumber = startLineNumber + j;
			let editText = (lines ? lines[j] : '');
			if (editLineNumber === startLineNumber || editLineNumber === endLineNumber) {
				const editStartColumn = (editLineNumber === startLineNumber ? startColumn : 1);
				const editEndColumn = (editLineNumber === endLineNumber ? endColumn : this._lines[editLineNumber - 1].length + 1);
				editText = (
					this._lines[editLineNumber - 1].substring(0, editStartColumn - 1)
					+ editText
					+ this._lines[editLineNumber - 1].substring(editEndColumn - 1)
				);
			}
			this._setLineContent(editLineNumber, editText);
		}

		if (editingLinesCnt < deletingLinesCnt) {
			// Must delete some lines
			const spliceStartLineNumber = startLineNumber + editingLinesCnt;
			const endLineRemains = this._lines[endLineNumber - 1].substring(endColumn - 1);
			this._setLineContent(spliceStartLineNumber, this._lines[spliceStartLineNumber - 1] + endLineRemains);
			this._lines.splice(spliceStartLineNumber, endLineNumber - spliceStartLineNumber);
			this._lineStarts.removeValues(spliceStartLineNumber, endLineNumber - spliceStartLineNumber);
		}

		if (editingLinesCnt < insertingLinesCnt) {
			// Must insert some lines
			const spliceLineNumber = startLineNumber + editingLinesCnt;
			let spliceColumn = (spliceLineNumber === startLineNumber ? startColumn : 1);
			spliceColumn += lines![editingLinesCnt].length;

			// Split last line
			const leftoverLine = this._lines[spliceLineNumber - 1].substring(spliceColumn - 1);
			this._setLineContent(spliceLineNumber, this._lines[spliceLineNumber - 1].substring(0, spliceColumn - 1));

			// Lines in the middle
			const newLines: string[] = new Array<string>(insertingLinesCnt - editingLinesCnt);
			const newLinesLengths = new Uint32Array(insertingLinesCnt - editingLinesCnt);
			for (let j = editingLinesCnt + 1; j <= insertingLinesCnt; j++) {
				newLines[j - editingLinesCnt - 1] = lines![j];
				newLinesLengths[j - editingLinesCnt - 1] = lines![j].length + this._EOL.length;
			}
			newLines[newLines.length - 1] += leftoverLine;
			newLinesLengths[newLines.length - 1] += leftoverLine.length;
			this._lines.splice(startLineNumber + editingLinesCnt, 0, ...newLines);
			this._lineStarts.insertValues(startLineNumber + editingLinesCnt, newLinesLengths);
		}

		return { rangeOffset, rangeLength, oldText };
	}

	private _setLineContent(lineNumber: number, content: string): void {
		this._lines[lineNumber - 1] = content;
		this._lineStarts.changeValue(lineNumber - 1, content.length + this._EOL.length);
	}
}

/**
 * Builds a LineArrayBuffer from the 64 KB chunks that fs.readFile delivers,
 * with the same responsibilities as PieceTreeTextBufferBuilder: strip the BOM,
 * count the kinds of line breaks to pick the buffer EOL, and stitch line
 * breaks and lines that straddle a chunk boundary.
 */
export class LineArrayBufferBuilder {
	private readonly _lines: string[] = [];
	private _partialLine = '';
	private _pendingCR = false;
	private _first = true;
	private _cr = 0;
	private _lf = 0;
	private _crlf = 0;

	acceptChunk(chunk: string): void {
		if (this._first) {
			this._first = false;
			if (startsWithUTF8BOM(chunk)) {
				chunk = chunk.substr(1);
			}
		}
		if (chunk.length === 0) {
			return;
		}

		let lineStart = 0;
		if (this._pendingCR) {
			// the previous chunk ended with \r: either this chunk completes a \r\n
			// or the \r was a line break on its own
			this._pendingCR = false;
			if (chunk.charCodeAt(0) === 10 /* \n */) {
				this._crlf++;
				lineStart = 1;
			} else {
				this._cr++;
			}
			this._lines.push(this._partialLine);
			this._partialLine = '';
		}

		const len = chunk.length;
		for (let i = lineStart; i < len; i++) {
			const ch = chunk.charCodeAt(i);
			if (ch === 13 /* \r */) {
				if (i + 1 < len) {
					this._pushLine(chunk, lineStart, i);
					if (chunk.charCodeAt(i + 1) === 10 /* \n */) {
						this._crlf++;
						i++;
					} else {
						this._cr++;
					}
					lineStart = i + 1;
				} else {
					// a \r as the very last char: decide in the next chunk (or in finish)
					this._partialLine += chunk.substring(lineStart, i);
					this._pendingCR = true;
					return;
				}
			} else if (ch === 10 /* \n */) {
				this._pushLine(chunk, lineStart, i);
				this._lf++;
				lineStart = i + 1;
			}
		}
		this._partialLine += chunk.substring(lineStart);
	}

	private _pushLine(chunk: string, start: number, end: number): void {
		if (this._partialLine.length > 0) {
			this._lines.push(this._partialLine + chunk.substring(start, end));
			this._partialLine = '';
		} else {
			this._lines.push(chunk.substring(start, end));
		}
	}

	finish(defaultEOL: '\r\n' | '\n' = '\n'): LineArrayBuffer {
		if (this._pendingCR) {
			this._pendingCR = false;
			this._cr++;
			this._lines.push(this._partialLine);
			this._partialLine = '';
		}
		this._lines.push(this._partialLine);

		// same rule as PieceTreeTextBufferFactory._getEOL
		const totalEOLCount = this._cr + this._lf + this._crlf;
		const totalCRCount = this._cr + this._crlf;
		let eol: '\r\n' | '\n';
		if (totalEOLCount === 0) {
			eol = defaultEOL;
		} else if (totalCRCount > totalEOLCount / 2) {
			eol = '\r\n';
		} else {
			eol = '\n';
		}
		return new LineArrayBuffer(this._lines, eol);
	}
}
