import { Prng } from '../test/prng';
import { IEditRange } from './lineArrayBuffer';

/*
 * The edit generators of VS Code's original text buffer benchmarks
 * (src/vs/editor/test/common/model/linesTextBuffer/textBufferAutoTestUtils.ts
 * at 1.21.0), made deterministic: every random choice comes from a seeded PRNG
 * so that two implementations receive exactly the same edits and a run can be
 * reproduced.
 */

export interface IEdit {
	range: IEditRange;
	text: string;
}

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';

/** The lines of a document, without their line breaks (the model the generators keep up to date). */
export function splitIntoLines(chunks: string[]): string[] {
	return chunks.join('').split(/\r\n|\r|\n/);
}

/**
 * `count` edits at random positions: pick a line, a random range inside it,
 * and either replace it with 5-10 random letters or delete it. `lines` is
 * updated as the edits are generated so later edits stay valid.
 */
export function generateRandomEdits(lines: string[], count: number, rng: Prng): IEdit[] {
	const edits: IEdit[] = [];
	for (let i = 0; i < count; i++) {
		const lineNumber = rng.nextIntBetween(1, lines.length);
		const line = lines[lineNumber - 1];
		const startColumn = rng.nextIntBetween(1, Math.max(line.length, 1));
		const endColumn = rng.nextIntBetween(startColumn, Math.max(line.length, startColumn));
		const text = rng.next() < 0.5 ? rng.nextString(LOWERCASE, rng.nextIntBetween(5, 10)) : '';

		edits.push({
			range: { startLineNumber: lineNumber, startColumn, endLineNumber: lineNumber, endColumn },
			text
		});
		lines[lineNumber - 1] = line.substring(0, startColumn - 1) + text + line.substring(endColumn - 1);
	}
	return edits;
}

/**
 * `count` inserts at the end of the document, mimicking typing: each one is
 * either a line break or 1-2 random letters.
 */
export function generateSequentialInserts(lines: string[], count: number, eol: string, rng: Prng): IEdit[] {
	const edits: IEdit[] = [];
	for (let i = 0; i < count; i++) {
		const lineNumber = lines.length;
		const column = lines[lineNumber - 1].length + 1;
		let text: string;
		if (rng.next() < 0.5) {
			text = eol;
			lines.push('');
		} else {
			text = rng.nextString(LOWERCASE, rng.nextIntBetween(1, 2));
			lines[lineNumber - 1] += text;
		}
		edits.push({
			range: { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column },
			text
		});
	}
	return edits;
}

/**
 * Start lines of `windowCount` windows of `windowSize` lines, for the
 * "read 10 random windows" benchmark (view code reading a screenful).
 */
export function generateWindowStarts(lineCount: number, windowCount: number, windowSize: number, rng: Prng): number[] {
	const starts: number[] = [];
	for (let i = 0; i < windowCount; i++) {
		starts.push(rng.nextIntBetween(1, Math.max(1, lineCount - windowSize)));
	}
	return starts;
}
