import assert from 'assert';
import { Range } from '../common/range';
import { PieceTreeBase } from '../pieceTreeBase';
import { DefaultEndOfLine, PieceTreeTextBufferBuilder } from '../pieceTreeBuilder';
import { LinesTextBuffer } from './linesTextBuffer';
import { Prng } from './prng';
import { assertTreeInvariants, createTextBuffer, readSnapshot } from './testUtils';

/**
 * Differential testing harness: the same edits are applied to a PieceTreeBase
 * and to the trivially-correct LinesTextBuffer, and every observable query is
 * compared after each step. A divergence is reported as a self-contained,
 * shrunk Scenario that can be pasted into differential.test.ts as a pinned
 * regression.
 */

export type EOL = '\r\n' | '\n';

export type Op =
	| { op: 'insert'; offset: number; text: string }
	| { op: 'delete'; offset: number; length: number }
	| { op: 'setEOL'; eol: EOL };

/**
 * `normalized` mimics how VS Code drives the tree: the builder normalizes line
 * endings, every inserted string only contains the buffer's EOL and is
 * inserted with `eolNormalized = true`, which keeps the `_EOLNormalized` fast
 * paths enabled.
 *
 * `mixed` feeds arbitrary `\r`, `\n` and `\r\n` combinations through the raw
 * `insert(offset, text)` API, exercising the CRLF stitching between pieces.
 */
export type Mode = 'normalized' | 'mixed';

export interface Scenario {
	mode: Mode;
	/** Chunks fed to PieceTreeTextBufferBuilder. */
	chunks: string[];
	defaultEOL: EOL;
	ops: Op[];
}

export interface Divergence {
	opIndex: number;
	error: Error;
}

export function createTree(scenario: Scenario): PieceTreeBase {
	const builder = new PieceTreeTextBufferBuilder();
	for (const chunk of scenario.chunks) {
		builder.acceptChunk(chunk);
	}
	const factory = builder.finish(scenario.mode === 'normalized');
	return factory.create(scenario.defaultEOL === '\r\n' ? DefaultEndOfLine.CRLF : DefaultEndOfLine.LF);
}

export function createModel(scenario: Scenario): LinesTextBuffer {
	const model = new LinesTextBuffer(scenario.chunks.join(''));
	if (scenario.mode === 'normalized') {
		// mirror what the builder does when normalizeEOL is on
		model.setEOL(detectEOL(model.getLinesRawContent(), scenario.defaultEOL));
	}
	return model;
}

/** Same rule as PieceTreeTextBufferFactory._getEOL. */
export function detectEOL(text: string, defaultEOL: EOL): EOL {
	let cr = 0, lf = 0, crlf = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 13) {
			if (text.charCodeAt(i + 1) === 10) {
				crlf++;
				i++;
			} else {
				cr++;
			}
		} else if (ch === 10) {
			lf++;
		}
	}
	const total = cr + lf + crlf;
	if (total === 0) {
		return defaultEOL;
	}
	return (cr + crlf > total / 2) ? '\r\n' : '\n';
}

/**
 * Applies `op` to both buffers. Offsets and lengths are clamped against the
 * current document so that shrunk scenarios (with ops removed) stay valid;
 * both sides always receive the identical, clamped operation.
 */
export function applyOp(tree: PieceTreeBase, model: LinesTextBuffer, op: Op, mode: Mode): void {
	const length = model.getLength();
	switch (op.op) {
		case 'insert': {
			if (op.text.length === 0) {
				return;
			}
			const offset = clamp(op.offset, 0, length);
			tree.insert(offset, op.text, mode === 'normalized');
			model.insert(offset, op.text);
			return;
		}
		case 'delete': {
			const offset = clamp(op.offset, 0, length);
			const cnt = clamp(op.length, 0, length - offset);
			if (cnt === 0) {
				return;
			}
			tree.delete(offset, cnt);
			model.delete(offset, cnt);
			return;
		}
		case 'setEOL':
			tree.setEOL(op.eol);
			model.setEOL(op.eol);
			return;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export interface CheckOptions {
	/** Deterministic source for the sampled checks (ranges, char codes). */
	rng: Prng;
	/**
	 * `getLineLength` assumes the buffer's EOL is used everywhere
	 * (it subtracts `_EOLLength`), so it is only meaningful for normalized
	 * buffers.
	 */
	checkLineLength: boolean;
	/** Also verify snapshots, `equal()`, line iterators, and (optionally) compact(). */
	thorough: boolean;
	/** After a thorough check, rebuild into ~64KB chunks and compare again. */
	compact?: boolean;
}

/**
 * Compares every public query of the tree with the reference model.
 * Uses node's assert instead of expect(): this runs in tight loops.
 */
export function assertEquivalent(tree: PieceTreeBase, model: LinesTextBuffer, options: CheckOptions): void {
	const { rng } = options;
	const raw = model.getLinesRawContent();
	const lineCount = model.getLineCount();

	assert.strictEqual(tree.getLength(), raw.length, 'getLength()');
	assert.strictEqual(tree.getLineCount(), lineCount, 'getLineCount()');
	assert.strictEqual(tree.getLinesRawContent(), raw, 'getLinesRawContent()');
	assert.deepStrictEqual(tree.getLinesContent(), model.getLinesContent(), 'getLinesContent()');

	// visit lines in a random order so the _lastVisitedLine cache is not always warm
	const firstLine = 1 + rng.nextInt(lineCount);
	for (let i = 0; i < lineCount; i++) {
		const line = 1 + ((firstLine - 1 + i) % lineCount);
		const expected = model.getLineContent(line);
		assert.strictEqual(tree.getLineContent(line), expected, `getLineContent(${line})`);
		if (options.checkLineLength) {
			assert.strictEqual(tree.getLineLength(line), expected.length, `getLineLength(${line})`);
		}
	}
	// the same line twice in a row hits the cache
	assert.strictEqual(tree.getLineContent(firstLine), model.getLineContent(firstLine), `getLineContent(${firstLine}) cached`);

	// offset <-> position, exhaustive for small documents, sampled otherwise
	const step = raw.length <= 2048 ? 1 : Math.ceil(raw.length / 1024);
	for (let offset = 0; offset <= raw.length; offset += step) {
		checkOffset(tree, model, offset);
	}
	checkOffset(tree, model, raw.length);
	// out of range offsets clamp to the document boundaries
	assert.ok(tree.getPositionAt(raw.length + 7).equals(model.getPositionAt(raw.length + 7)), 'getPositionAt(beyond end)');
	assert.ok(tree.getPositionAt(-3).equals(model.getPositionAt(-3)), 'getPositionAt(negative)');

	// character access, including inside line terminators
	const charSamples = Math.min(raw.length, 64);
	for (let i = 0; i < charSamples; i++) {
		const offset = rng.nextInt(raw.length);
		const pos = model.getPositionAt(offset);
		assert.strictEqual(
			tree.getLineCharCode(pos.lineNumber, pos.column - 1),
			raw.charCodeAt(offset),
			`getLineCharCode(${pos.lineNumber}, ${pos.column - 1}) (offset ${offset})`
		);
		assert.strictEqual(tree.getCharCode(offset), raw.charCodeAt(offset), `getCharCode(${offset})`);
		const chunk = tree.getNearestChunk(offset);
		assert.strictEqual(chunk, raw.substring(offset, offset + chunk.length), `getNearestChunk(${offset})`);
		assert.ok(chunk.length > 0, `getNearestChunk(${offset}) empty inside the document`);
	}
	assert.strictEqual(tree.getCharCode(raw.length), 0, 'getCharCode(end)');
	assert.strictEqual(tree.getNearestChunk(raw.length), '', 'getNearestChunk(end)');

	// ranges, biased towards short ones
	for (let i = 0; i < 24; i++) {
		let a = rng.nextInt(raw.length + 1);
		let b = i % 2 === 0 ? rng.nextInt(raw.length + 1) : clamp(a + rng.nextInt(8), 0, raw.length);
		if (a > b) {
			[a, b] = [b, a];
		}
		const pa = model.getPositionAt(a);
		const pb = model.getPositionAt(b);
		const range = new Range(pa.lineNumber, pa.column, pb.lineNumber, pb.column);
		assert.strictEqual(tree.getValueInRange(range), raw.substring(a, b), `getValueInRange(${range})`);
	}

	assertTreeInvariants(tree);

	if (options.thorough) {
		assert.strictEqual(readSnapshot(tree.createSnapshot('')), raw, 'createSnapshot()');
		assert.ok(tree.equal(createTextBuffer([raw], false)), 'equal(tree built from the same text)');

		const walked: string[] = [];
		tree.forEachLine((line, lineNumber) => {
			assert.strictEqual(lineNumber, walked.length + 1, `forEachLine lineNumber at ${walked.length}`);
			walked.push(line);
		});
		assert.deepStrictEqual(walked, model.getLinesContent(), 'forEachLine()');
		assert.deepStrictEqual([...tree.iterateLineContents()], model.getLinesContent(), 'iterateLineContents()');

		if (options.compact) {
			tree.compact();
			assertEquivalent(tree, model, { ...options, thorough: false, compact: false });
		}
	}
}

function checkOffset(tree: PieceTreeBase, model: LinesTextBuffer, offset: number): void {
	const expected = model.getPositionAt(offset);
	const actual = tree.getPositionAt(offset);
	assert.ok(actual.equals(expected), `getPositionAt(${offset}): got ${actual}, want ${expected}`);
	assert.strictEqual(tree.getOffsetAt(expected.lineNumber, expected.column), offset, `getOffsetAt(${expected})`);
}

export interface RunOptions {
	/** Run the full comparison after every `checkEvery`-th op (and always after the last). */
	checkEvery?: number;
	thorough?: boolean;
	/** After each thorough check, compact() the tree and compare again. */
	compact?: boolean;
	/** Override how the tree under test is built (used to self-test the harness). */
	createTree?: (scenario: Scenario) => PieceTreeBase;
}

/**
 * Replays a scenario and returns the first divergence, or null if the tree
 * agreed with the reference model throughout.
 */
export function runScenario(scenario: Scenario, options: RunOptions = {}): Divergence | null {
	const checkEvery = options.checkEvery ?? 1;
	const tree = (options.createTree ?? createTree)(scenario);
	const model = createModel(scenario);
	// fixed seed: the sampled checks must not depend on how the scenario was produced
	const checkOptions: CheckOptions = {
		rng: new Prng(0x5eed),
		checkLineLength: scenario.mode === 'normalized',
		thorough: options.thorough ?? true,
		compact: options.compact ?? false,
	};

	try {
		assertEquivalent(tree, model, checkOptions);
	} catch (error) {
		return { opIndex: -1, error: error as Error };
	}

	for (let i = 0; i < scenario.ops.length; i++) {
		try {
			applyOp(tree, model, scenario.ops[i], scenario.mode);
			if ((i + 1) % checkEvery === 0 || i === scenario.ops.length - 1) {
				assertEquivalent(tree, model, checkOptions);
			}
		} catch (error) {
			return { opIndex: i, error: error as Error };
		}
	}
	return null;
}

export interface GenerateOptions {
	seed: number;
	mode: Mode;
	opCount: number;
	/** Upper bound for the initial document length. */
	initialLength?: number;
	/** Upper bound for the size of ordinary inserts. */
	insertLength?: number;
	/** Probability of the rare, large edits (big multi-line inserts / deletes). */
	bigEditRate?: number;
}

const WORDS = 'abcdefghij';

/**
 * Generates a random editing session. Line breaks are deliberately dense
 * (about a third of all characters) since that is where the piece tree's
 * bookkeeping lives. The session mixes random-access edits with runs of
 * "typing" at a cursor, which is what drives the tree's change-buffer
 * append optimisation (_lastChangeBufferPos).
 *
 * Contract: while the tree believes its EOLs are normalized (built with
 * normalizeEOL, or after setEOL, and until a raw insert), the fast paths in
 * getLineContent/getLineLength assume every line break is exactly the buffer
 * EOL. An edit that splits a `\r\n` pair on such a buffer breaks that
 * assumption. VS Code can never do this because TextModel validates positions
 * to column boundaries, so the generator never does it either: edits on a
 * normalized buffer are snapped off the middle of `\r\n`.
 */
export function generateScenario(options: GenerateOptions): Scenario {
	const rng = new Prng(options.seed);
	const mode = options.mode;
	const initialLength = options.initialLength ?? 200;
	const insertLength = options.insertLength ?? 16;
	const bigEditRate = options.bigEditRate ?? 0.04;

	let eol: EOL = rng.next() < 0.5 ? '\n' : '\r\n';
	const defaultEOL = eol;

	const randomText = (maxLength: number): string => {
		const length = 1 + rng.nextInt(maxLength);
		let text = '';
		for (let i = 0; i < length; i++) {
			const r = rng.next();
			if (r < 0.66) {
				text += WORDS[rng.nextInt(WORDS.length)];
			} else if (mode === 'normalized') {
				text += eol;
			} else if (r < 0.78) {
				text += '\n';
			} else if (r < 0.90) {
				text += '\r';
			} else {
				text += '\r\n';
			}
		}
		return text;
	};

	// initial content, split into a few chunks (possibly between \r and \n)
	let text = rng.next() < 0.1 ? '' : randomText(initialLength);
	const chunks: string[] = [];
	let rest = text;
	const chunkCount = 1 + rng.nextInt(4);
	for (let i = 1; i < chunkCount && rest.length > 1; i++) {
		const cut = 1 + rng.nextInt(rest.length - 1);
		chunks.push(rest.substring(0, cut));
		rest = rest.substring(cut);
	}
	chunks.push(rest);

	// mirror the tree's _EOLNormalized state
	let normalized = mode === 'normalized';
	if (normalized) {
		eol = detectEOL(text, defaultEOL);
		text = text.replace(/\r\n|\r|\n/g, eol);
	}
	let cursor = text.length;

	const splitsCRLF = (offset: number): boolean =>
		offset > 0 && offset < text.length && text.charCodeAt(offset - 1) === 13 && text.charCodeAt(offset + 0) === 10;

	const ops: Op[] = [];
	const insert = (offset: number, value: string) => {
		if (normalized && splitsCRLF(offset)) {
			offset++;
		}
		ops.push({ op: 'insert', offset, text: value });
		text = text.substring(0, offset) + value + text.substring(offset);
		cursor = offset + value.length;
		normalized = normalized && mode === 'normalized';
	};
	const del = (offset: number, length: number) => {
		if (normalized) {
			if (splitsCRLF(offset)) {
				offset--;
				length++;
			}
			if (splitsCRLF(offset + length)) {
				length++;
			}
		}
		ops.push({ op: 'delete', offset, length });
		text = text.substring(0, offset) + text.substring(offset + length);
		if (cursor > offset) {
			cursor = Math.max(offset, cursor - length);
		}
	};
	const setEOL = (newEOL: EOL) => {
		ops.push({ op: 'setEOL', eol: newEOL });
		text = text.replace(/\r\n|\r|\n/g, newEOL);
		eol = newEOL;
		normalized = true;
		cursor = Math.min(cursor, text.length);
	};

	for (let i = 0; i < options.opCount; i++) {
		const length = text.length;
		const r = rng.next();
		if (r < bigEditRate) {
			if (rng.next() < 0.5 || length === 0) {
				insert(rng.nextInt(length + 1), randomText(insertLength * 40));
			} else {
				const offset = rng.nextInt(length);
				del(offset, 1 + rng.nextInt(length - offset));
			}
		} else if (r < 0.02 + bigEditRate) {
			setEOL(eol === '\n' ? '\r\n' : '\n');
		} else if (length === 0 || r < 0.35) {
			insert(rng.nextInt(length + 1), randomText(insertLength));
		} else if (r < 0.55) {
			// typing at the cursor, one or a few characters at a time
			insert(cursor, randomText(3));
		} else if (r < 0.65 && cursor > 0) {
			// backspace
			del(cursor - 1, 1);
		} else {
			const offset = rng.nextInt(length);
			del(offset, 1 + rng.nextInt(Math.min(length - offset, insertLength)));
		}
		assert.ok(cursor >= 0 && cursor <= text.length, `generator cursor ${cursor} out of range`);
	}

	return { mode, chunks, defaultEOL, ops };
}

/**
 * Delta debugging: removes ops (ddmin over the op list), then initial chunks,
 * then trims inserted texts, as long as the scenario still diverges, within a
 * time budget. The harness checks after every op, so whatever remains is also
 * truncated to the failing prefix.
 */
export function shrinkScenario(scenario: Scenario, divergence: Divergence, options: RunOptions = {}, budgetMs: number = 3000): Scenario {
	const deadline = Date.now() + budgetMs;
	let current: Scenario = { ...scenario, ops: scenario.ops.slice(0, divergence.opIndex + 1) };

	const stillFails = (candidate: Scenario): Scenario | null => {
		const result = runScenario(candidate, { ...options, checkEvery: 1 });
		return result ? { ...candidate, ops: candidate.ops.slice(0, result.opIndex + 1) } : null;
	};

	// ddmin over ops: try removing ever smaller slices
	let granularity = 2;
	while (current.ops.length >= 2 && Date.now() < deadline) {
		const sliceSize = Math.ceil(current.ops.length / granularity);
		let removed = false;
		for (let start = 0; start < current.ops.length && Date.now() < deadline; start += sliceSize) {
			const ops = current.ops.slice(0, start).concat(current.ops.slice(start + sliceSize));
			const shrunk = stillFails({ ...current, ops });
			if (shrunk) {
				current = shrunk;
				granularity = Math.max(granularity - 1, 2);
				removed = true;
				break;
			}
		}
		if (!removed) {
			if (granularity >= current.ops.length) {
				break;
			}
			granularity = Math.min(granularity * 2, current.ops.length);
		}
	}

	for (let i = current.chunks.length - 1; i >= 0 && Date.now() < deadline; i--) {
		const chunks = current.chunks.slice(0, i).concat(current.chunks.slice(i + 1));
		const shrunk = stillFails({ ...current, chunks: chunks.length ? chunks : [''] });
		if (shrunk) {
			current = shrunk;
		}
	}

	// trim inserted texts from either end
	let changed = true;
	while (changed && Date.now() < deadline) {
		changed = false;
		for (let i = 0; i < current.ops.length && Date.now() < deadline; i++) {
			const op = current.ops[i];
			if (op.op !== 'insert' || op.text.length <= 1) {
				continue;
			}
			for (const text of [op.text.substring(1), op.text.substring(0, op.text.length - 1)]) {
				const ops = current.ops.slice();
				ops[i] = { op: 'insert', offset: op.offset, text };
				const shrunk = stillFails({ ...current, ops });
				if (shrunk) {
					current = shrunk;
					changed = true;
					break;
				}
			}
		}
	}
	return current;
}

export function formatDivergence(scenario: Scenario, divergence: Divergence, shrunk: Scenario): string {
	const op = divergence.opIndex >= 0 ? JSON.stringify(scenario.ops[divergence.opIndex]) : '(initial state)';
	return [
		`Piece tree diverged from the reference buffer after op #${divergence.opIndex} ${op}:`,
		`  ${divergence.error.message.split('\n').join('\n  ')}`,
		'',
		`Shrunk to ${shrunk.ops.length} op(s). Pin it as a regression in differential.test.ts:`,
		JSON.stringify(shrunk),
	].join('\n');
}

/** Test-facing entry point: fails with a replayable, shrunk scenario. */
export function expectNoDivergence(scenario: Scenario, options: RunOptions = {}): void {
	const divergence = runScenario(scenario, options);
	if (divergence) {
		const shrunk = shrinkScenario(scenario, divergence, options);
		throw new Error(formatDivergence(scenario, divergence, shrunk));
	}
}
