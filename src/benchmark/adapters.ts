import { Range } from '../common/range';
import { PieceTreeBase } from '../pieceTreeBase';
import { DefaultEndOfLine, PieceTreeTextBufferBuilder } from '../pieceTreeBuilder';
import { IAppliedEdit, IEditRange, LineArrayBufferBuilder } from './lineArrayBuffer';

/**
 * The slice of VS Code's ITextBuffer that the benchmarks exercise, implemented
 * for both buffers the way the two TextBuffer classes of VS Code 1.21 did it.
 * In particular an edit is given as a line/column range and, as in
 * `applyEdits`, yields the offset/length of the range and the text it replaced
 * (needed for the content-change event and the undo stack): the piece tree
 * has to translate positions to offsets, the line array indexes its array
 * but has to keep its prefix sums of line lengths up to date.
 */
export interface IBenchBuffer {
	getEOL(): string;
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
	/** The full text, as a save would read it. */
	getValue(): string;
	applyEdit(range: IEditRange, text: string): IAppliedEdit;
}

export interface IBufferImplementation {
	readonly name: string;
	/** Build a buffer from the 64 KB chunks a file read delivers. */
	build(chunks: string[]): IBenchBuffer;
}

const EOL_REGEX = /\r\n|\r|\n/;

class PieceTreeBenchBuffer implements IBenchBuffer {
	constructor(private readonly _tree: PieceTreeBase) { }

	getEOL(): string {
		return this._tree.getEOL();
	}

	getLineCount(): number {
		return this._tree.getLineCount();
	}

	getLineContent(lineNumber: number): string {
		return this._tree.getLineContent(lineNumber);
	}

	getValue(): string {
		return this._tree.getLinesRawContent();
	}

	/** PieceTreeTextBuffer.applyEdits for a single operation. */
	applyEdit(range: IEditRange, text: string): IAppliedEdit {
		const tree = this._tree;
		const rangeOffset = tree.getOffsetAt(range.startLineNumber, range.startColumn);
		const rangeLength = range.startLineNumber === range.endLineNumber
			? range.endColumn - range.startColumn
			: tree.getOffsetAt(range.endLineNumber, range.endColumn) - rangeOffset;
		const oldText = rangeLength === 0
			? ''
			: tree.getValueInRange(new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn));
		// split and re-join: the inserted text is normalized to the buffer's EOL
		const normalizedText = text.length > 0 ? text.split(EOL_REGEX).join(tree.getEOL()) : '';

		if (rangeLength > 0) {
			tree.delete(rangeOffset, rangeLength);
		}
		if (normalizedText.length > 0) {
			tree.insert(rangeOffset, normalizedText, true);
		}
		return { rangeOffset, rangeLength, oldText };
	}
}

export const pieceTreeImplementation: IBufferImplementation = {
	name: 'piece tree',
	build(chunks: string[]): IBenchBuffer {
		const builder = new PieceTreeTextBufferBuilder();
		for (let i = 0; i < chunks.length; i++) {
			builder.acceptChunk(chunks[i]);
		}
		return new PieceTreeBenchBuffer(builder.finish(true).create(DefaultEndOfLine.LF));
	}
};

export const lineArrayImplementation: IBufferImplementation = {
	name: 'line array',
	build(chunks: string[]): IBenchBuffer {
		const builder = new LineArrayBufferBuilder();
		for (let i = 0; i < chunks.length; i++) {
			builder.acceptChunk(chunks[i]);
		}
		return builder.finish('\n');
	}
};

/** In the column order of the blog post's charts. */
export const implementations: IBufferImplementation[] = [lineArrayImplementation, pieceTreeImplementation];
