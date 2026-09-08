import { Range } from '../common/range';
import { PersistentPieceTree, PieceTreeVersion } from '../persistentPieceTree';
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
	getPositionAt(offset: number): { lineNumber: number; column: number };
	/** The full text, as a save would read it. */
	getValue(): string;
	applyEdit(range: IEditRange, text: string): IAppliedEdit;
	/**
	 * Buffers that keep versions implement these: `captureVersion` takes the
	 * current document in O(1), `restoreVersion` brings it back in O(1). The
	 * undo benchmark uses them where available and replays inverse edits
	 * otherwise, which is how an undo stack of edits (VS Code's) works.
	 */
	captureVersion?(): unknown;
	restoreVersion?(version: unknown): void;
}

export interface IBufferImplementation {
	readonly name: string;
	/** Build a buffer from the 64 KB chunks a file read delivers. */
	build(chunks: string[]): IBenchBuffer;
}

const EOL_REGEX = /\r\n|\r|\n/;

class PieceTreeBenchBuffer implements IBenchBuffer {
	constructor(protected readonly _tree: PieceTreeBase | PersistentPieceTree) { }

	getEOL(): string {
		return this._tree.getEOL();
	}

	getLineCount(): number {
		return this._tree.getLineCount();
	}

	getLineContent(lineNumber: number): string {
		return this._tree.getLineContent(lineNumber);
	}

	getPositionAt(offset: number): { lineNumber: number; column: number } {
		return this._tree.getPositionAt(offset);
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

/** The same protocol on the persistent tree, plus versions as snapshots. */
class PersistentPieceTreeBenchBuffer extends PieceTreeBenchBuffer {
	constructor(private readonly _persistent: PersistentPieceTree) {
		super(_persistent);
	}

	captureVersion(): unknown {
		return this._persistent.getVersion();
	}

	restoreVersion(version: unknown): void {
		this._persistent.restoreVersion(version as PieceTreeVersion);
	}
}

function chunkBuilder(chunks: string[]): PieceTreeTextBufferBuilder {
	const builder = new PieceTreeTextBufferBuilder();
	for (let i = 0; i < chunks.length; i++) {
		builder.acceptChunk(chunks[i]);
	}
	return builder;
}

export const pieceTreeImplementation: IBufferImplementation = {
	name: 'piece tree',
	build(chunks: string[]): IBenchBuffer {
		return new PieceTreeBenchBuffer(chunkBuilder(chunks).finish(true).create(DefaultEndOfLine.LF));
	}
};

export const persistentPieceTreeImplementation: IBufferImplementation = {
	name: 'persistent piece tree',
	build(chunks: string[]): IBenchBuffer {
		return new PersistentPieceTreeBenchBuffer(chunkBuilder(chunks).finish(true).createPersistent(DefaultEndOfLine.LF));
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

/** In the column order of the blog post's charts, plus the persistent tree. */
export const implementations: IBufferImplementation[] = [lineArrayImplementation, pieceTreeImplementation, persistentPieceTreeImplementation];
