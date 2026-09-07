import { Position } from '../common/position';
import { Range } from '../common/range';

/**
 * Splits text into lines where every line except the last keeps its own
 * terminator (`\r\n`, `\r` or `\n`). `'a\r\nb\n'` -> `['a\r\n', 'b\n', '']`.
 */
export function splitLinesKeepingTerminators(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 13 /* \r */) {
			if (i + 1 < text.length && text.charCodeAt(i + 1) === 10 /* \n */) {
				i++;
			}
			lines.push(text.substring(start, i + 1));
			start = i + 1;
		} else if (ch === 10 /* \n */) {
			lines.push(text.substring(start, i + 1));
			start = i + 1;
		}
	}
	lines.push(text.substring(start));
	return lines;
}

function stripTerminator(line: string): string {
	const len = line.length;
	if (len > 0 && line.charCodeAt(len - 1) === 10) {
		return (len > 1 && line.charCodeAt(len - 2) === 13) ? line.substring(0, len - 2) : line.substring(0, len - 1);
	}
	if (len > 0 && line.charCodeAt(len - 1) === 13) {
		return line.substring(0, len - 1);
	}
	return line;
}

/**
 * A deliberately simple array-of-lines text buffer, in the spirit of the
 * buffer VS Code used before the piece tree.
 *
 * Every entry of `_lines` holds one line *including* its terminator; only the
 * last line has none. All operations are plain string/array manipulation,
 * which makes this easy to trust as a reference model for the piece tree
 * (differential.test.ts) and a natural baseline for the benchmarks.
 *
 * Offsets, line numbers and columns follow the piece tree conventions:
 * offsets are 0-based, lines and columns are 1-based, and a column may point
 * inside a line terminator (e.g. between `\r` and `\n`).
 */
export class LinesTextBuffer {
	private _lines: string[];

	constructor(text: string) {
		this._lines = splitLinesKeepingTerminators(text);
	}

	getLength(): number {
		let length = 0;
		for (const line of this._lines) {
			length += line.length;
		}
		return length;
	}

	getLineCount(): number {
		return this._lines.length;
	}

	getLineContent(lineNumber: number): string {
		return stripTerminator(this._lines[lineNumber - 1]);
	}

	getLineLength(lineNumber: number): number {
		return this.getLineContent(lineNumber).length;
	}

	getLinesContent(): string[] {
		return this._lines.map(stripTerminator);
	}

	getLinesRawContent(): string {
		return this._lines.join('');
	}

	/** @param index 0-based; may address the line terminator */
	getLineCharCode(lineNumber: number, index: number): number {
		return this._lines[lineNumber - 1].charCodeAt(index);
	}

	getOffsetAt(lineNumber: number, column: number): number {
		let offset = 0;
		for (let i = 0; i < lineNumber - 1; i++) {
			offset += this._lines[i].length;
		}
		return offset + column - 1;
	}

	/** Like the piece tree, offsets outside the document clamp to its start/end. */
	getPositionAt(offset: number): Position {
		offset = Math.min(Math.max(0, Math.floor(offset)), this.getLength());
		let lineStart = 0;
		const lastLine = this._lines.length - 1;
		for (let i = 0; i < lastLine; i++) {
			const nextLineStart = lineStart + this._lines[i].length;
			if (offset < nextLineStart) {
				return new Position(i + 1, offset - lineStart + 1);
			}
			lineStart = nextLineStart;
		}
		return new Position(lastLine + 1, offset - lineStart + 1);
	}

	getValueInRange(range: Range): string {
		const start = this.getOffsetAt(range.startLineNumber, range.startColumn);
		const end = this.getOffsetAt(range.endLineNumber, range.endColumn);
		return this.getLinesRawContent().substring(start, end);
	}

	insert(offset: number, text: string): void {
		if (text.length === 0) {
			return;
		}
		this._splice(offset, 0, text);
	}

	setEOL(eol: '\r\n' | '\n'): void {
		this._lines = splitLinesKeepingTerminators(this.getLinesRawContent().replace(/\r\n|\r|\n/g, eol));
	}

	delete(offset: number, cnt: number): void {
		if (cnt <= 0) {
			return;
		}
		this._splice(offset, cnt, '');
	}

	/**
	 * Replaces `cnt` characters at `offset` with `text` by re-splitting only
	 * the affected lines. The line before the edit is included because a
	 * `\r` ending it may merge with a `\n` that the edit brings next to it.
	 */
	private _splice(offset: number, cnt: number, text: string): void {
		const startLine = this._lineIndexAt(offset);
		const endLine = this._lineIndexAt(offset + cnt);
		const first = Math.max(0, startLine - 1);
		const isLastLine = endLine === this._lines.length - 1;

		let firstOffset = 0;
		for (let i = 0; i < first; i++) {
			firstOffset += this._lines[i].length;
		}

		const chunk = this._lines.slice(first, endLine + 1).join('');
		const local = offset - firstOffset;
		const edited = chunk.substring(0, local) + text + chunk.substring(local + cnt);
		const newLines = splitLinesKeepingTerminators(edited);
		if (!isLastLine) {
			// the chunk ends with an intact terminator, so the split produced a
			// trailing empty line that really belongs to the next, untouched line
			newLines.pop();
		}
		if (newLines.length < 10000) {
			this._lines.splice(first, endLine - first + 1, ...newLines);
		} else {
			// avoid blowing the argument limit of splice(...) for huge multi-line inserts
			this._lines = this._lines.slice(0, first).concat(newLines, this._lines.slice(endLine + 1));
		}
	}

	/** Index of the line containing `offset`; a line start maps to that line. */
	private _lineIndexAt(offset: number): number {
		let lineStart = 0;
		const lastLine = this._lines.length - 1;
		for (let i = 0; i < lastLine; i++) {
			lineStart += this._lines[i].length;
			if (offset < lineStart) {
				return i;
			}
		}
		return lastLine;
	}
}
