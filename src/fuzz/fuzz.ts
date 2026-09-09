/*
 * Long-running differential fuzzing of the two piece trees.
 *
 *   npm run fuzz                          # all cores but one, 10 minutes
 *   npm run fuzz -- --minutes 60          # a longer campaign
 *   npm run fuzz -- --scenarios 2000      # a fixed amount of work instead of a time budget
 *   npm run fuzz -- --seed 7 --workers 1  # reproducible single-process run
 *   npm run fuzz -- --json fuzz.json      # also write the statistics (and any failure) as JSON
 *
 * Every scenario is a random editing session (src/test/differential.ts's
 * generator, with the document size, edit sizes and line-ending mode drawn at
 * random per scenario) applied step by step to three buffers: the persistent
 * piece tree, the mutable PieceTreeBase it reimplements, and the trivially
 * correct array-of-lines LinesTextBuffer. After every edit the three must
 * agree on the text, the line count and a sample of line, offset/position and
 * range queries; periodically, and at the end, every public query of both
 * trees is compared with the model exhaustively (assertEquivalent) and the
 * tree invariants are checked.
 *
 * The persistent tree is also tested for what only it can do: a version is
 * taken after every edit and old versions are restored and re-read while the
 * session goes on; half of the scenarios branch, i.e. return to a random
 * earlier version and continue editing from there (the other two buffers are
 * rebuilt from that version's text so the comparison continues); the other
 * half drive a PieceTreeHistory and finally undo every edit, then redo every
 * edit, comparing the document with what it was at each step.
 *
 * A divergence is shrunk with the harness's delta debugging and printed as a
 * scenario that can be pinned in differential.test.ts. Seeds make every run
 * reproducible: scenario k of a run with --seed S is generated from S + k.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { PersistentPieceTree, PieceTreeHistory, PieceTreeVersion } from '../persistentPieceTree';
import { StringBuffer, createLineStartsFast } from '../pieceBuffers';
import { PieceTreeBase } from '../pieceTreeBase';
import { Range } from '../common/range';
import {
	Mode, Op, Scenario, applyOpToModel, applyOpToTree, assertEquivalent, createModel, createTree, effectiveOp, formatDivergence, generateScenario, runScenario, shrinkScenario
} from '../test/differential';
import { LinesTextBuffer } from '../test/linesTextBuffer';
import { Prng } from '../test/prng';
import { IPieceTree, TreeFlavor, assertTreeInvariants } from '../test/testUtils';

// ---- options -----------------------------------------------------------------

interface IOptions {
	minutes: number | null;
	scenarios: number | null;
	seed: number;
	workers: number;
	json: string | null;
	/** Internal: this process is a worker; run scenarios and report to the parent. */
	worker: boolean;
	/** Internal: for a worker, the number of scenarios per worker slot (see scheduling). */
	stride: number;
	offset: number;
}

const HELP = `Differential fuzzing of PersistentPieceTree against PieceTreeBase and an array-of-lines model.

Options:
  --minutes <m>     run for m minutes (default 10, unless --scenarios is given)
  --scenarios <n>   run exactly n scenarios instead of a time budget
  --seed <s>        seed of the campaign (default: random); scenario k uses seed s + k
  --workers <w>     parallel processes (default: all cores but one)
  --json <file>     write the statistics, and any failure, as JSON
  --help
`;

function parseArgs(argv: string[]): IOptions {
	const options: IOptions = {
		minutes: null, scenarios: null, seed: Math.floor(Math.random() * 0x7fffffff), workers: Math.max(1, os.availableParallelism() - 1),
		json: null, worker: false, stride: 1, offset: 0
	};
	for (let i = 0; i < argv.length; i++) {
		const value = () => {
			const v = argv[++i];
			if (v === undefined) {
				throw new Error(`missing value for ${argv[i - 1]}`);
			}
			return v;
		};
		switch (argv[i]) {
			case '--minutes': options.minutes = parseFloat(value()); break;
			case '--scenarios': options.scenarios = parseInt(value(), 10); break;
			case '--seed': options.seed = parseInt(value(), 10); break;
			case '--workers': options.workers = parseInt(value(), 10); break;
			case '--json': options.json = value(); break;
			case '--worker': options.worker = true; break;
			case '--stride': options.stride = parseInt(value(), 10); break;
			case '--offset': options.offset = parseInt(value(), 10); break;
			case '--help': case '-h': process.stdout.write(HELP); process.exit(0);
			default: throw new Error(`unknown option ${argv[i]}\n${HELP}`);
		}
	}
	if (options.minutes === null && options.scenarios === null) {
		options.minutes = 10;
	}
	return options;
}

// ---- what a scenario looks like -----------------------------------------------

interface ISizeClass {
	readonly name: string;
	readonly initialLength: number;
	readonly opCount: number;
	readonly insertLength: number;
	readonly bigEditRate: number;
	/** Exhaustive comparison every this many ops (the cheap one runs after every op). */
	readonly checkEvery: number;
	readonly weight: number;
}

const SIZE_CLASSES: readonly ISizeClass[] = [
	{ name: 'tiny', initialLength: 40, opCount: 300, insertLength: 4, bigEditRate: 0.02, checkEvery: 1, weight: 30 },
	{ name: 'small', initialLength: 400, opCount: 300, insertLength: 12, bigEditRate: 0.04, checkEvery: 1, weight: 30 },
	{ name: 'medium', initialLength: 6000, opCount: 250, insertLength: 40, bigEditRate: 0.05, checkEvery: 5, weight: 25 },
	{ name: 'large', initialLength: 80000, opCount: 150, insertLength: 200, bigEditRate: 0.06, checkEvery: 25, weight: 10 },
	// big edits of up to insertLength * 40 characters: above AverageBufferSize, the inserted text gets buffers of its own
	{ name: 'huge inserts', initialLength: 2000, opCount: 60, insertLength: 2500, bigEditRate: 0.3, checkEvery: 5, weight: 5 },
];

function pickSizeClass(rng: Prng): ISizeClass {
	const total = SIZE_CLASSES.reduce((sum, c) => sum + c.weight, 0);
	let r = rng.nextInt(total);
	for (const c of SIZE_CLASSES) {
		if (r < c.weight) {
			return c;
		}
		r -= c.weight;
	}
	return SIZE_CLASSES[SIZE_CLASSES.length - 1];
}

// ---- statistics ---------------------------------------------------------------

interface IStats {
	scenarios: number;
	ops: number;
	/** Cheap three-way comparisons (after every op). */
	quickChecks: number;
	/** Exhaustive comparisons of a tree with the model (two per checkpoint). */
	fullChecks: number;
	versionsVerified: number;
	branches: number;
	undoRedoSteps: number;
	setEOLs: number;
	/** Inserts longer than AverageBufferSize, which get buffers of their own. */
	hugeInserts: number;
	maxDocumentLength: number;
	byMode: Record<Mode, number>;
	bySize: Record<string, number>;
}

function emptyStats(): IStats {
	const bySize: Record<string, number> = {};
	for (const c of SIZE_CLASSES) {
		bySize[c.name] = 0;
	}
	return {
		scenarios: 0, ops: 0, quickChecks: 0, fullChecks: 0, versionsVerified: 0, branches: 0, undoRedoSteps: 0, setEOLs: 0, hugeInserts: 0,
		maxDocumentLength: 0, byMode: { normalized: 0, mixed: 0 }, bySize
	};
}

function addStats(into: IStats, from: IStats): void {
	into.scenarios += from.scenarios;
	into.ops += from.ops;
	into.quickChecks += from.quickChecks;
	into.fullChecks += from.fullChecks;
	into.versionsVerified += from.versionsVerified;
	into.branches += from.branches;
	into.undoRedoSteps += from.undoRedoSteps;
	into.setEOLs += from.setEOLs;
	into.hugeInserts += from.hugeInserts;
	into.maxDocumentLength = Math.max(into.maxDocumentLength, from.maxDocumentLength);
	into.byMode.normalized += from.byMode.normalized;
	into.byMode.mixed += from.byMode.mixed;
	for (const name of Object.keys(from.bySize)) {
		into.bySize[name] = (into.bySize[name] ?? 0) + from.bySize[name];
	}
}

interface IFailure {
	seed: number;
	sizeClass: string;
	/** Which comparison failed: a tree against the model, or the persistent tree's versions/history. */
	kind: 'persistent' | 'mutable' | 'versions' | 'history';
	opIndex: number;
	message: string;
	scenario: Scenario;
	/** The shrunk scenario, when the failure is one the single-tree harness reproduces. */
	shrunk: Scenario | null;
	report: string;
}

// ---- one scenario --------------------------------------------------------------

class Divergence extends Error {
	constructor(readonly kind: IFailure['kind'], readonly opIndex: number, message: string) {
		super(message);
	}
}

const AVERAGE_BUFFER_SIZE = 65535;

/** The generator never splits a \r\n of a normalized buffer; after a branch the text differs from the generator's, so the fuzzer snaps as it does. */
function snapToLineBreaks(op: Op, text: string): Op {
	const splits = (offset: number) => offset > 0 && offset < text.length && text.charCodeAt(offset - 1) === 13 && text.charCodeAt(offset) === 10;
	if (op.op === 'insert') {
		return splits(op.offset) ? { ...op, offset: op.offset + 1 } : op;
	}
	if (op.op === 'delete') {
		let { offset, length } = op;
		if (splits(offset)) {
			offset--;
			length++;
		}
		if (splits(offset + length)) {
			length++;
		}
		return { op: 'delete', offset, length };
	}
	return op;
}

function rebuildMutable(raw: string, eol: '\r\n' | '\n', eolNormalized: boolean): PieceTreeBase {
	return new PieceTreeBase(raw.length === 0 ? [] : [new StringBuffer(raw, createLineStartsFast(raw))], eol, eolNormalized);
}

/** The cheap comparison after every op: text, counts, and a few sampled queries on each tree. */
function quickCheck(persistent: PersistentPieceTree, mutable: PieceTreeBase, model: LinesTextBuffer, raw: string, rng: Prng): void {
	const lineCount = model.getLineCount();
	const trees: [string, IPieceTree][] = [['persistent', persistent], ['mutable', mutable]];
	for (const [name, tree] of trees) {
		if (tree.getLength() !== raw.length) {
			throw new Divergence(name as TreeFlavor, -1, `${name}: getLength() ${tree.getLength()}, model ${raw.length}`);
		}
		if (tree.getLineCount() !== lineCount) {
			throw new Divergence(name as TreeFlavor, -1, `${name}: getLineCount() ${tree.getLineCount()}, model ${lineCount}`);
		}
		if (tree.getLinesRawContent() !== raw) {
			throw new Divergence(name as TreeFlavor, -1, `${name}: getLinesRawContent() differs from the model`);
		}
		for (let i = 0; i < 4; i++) {
			const line = 1 + rng.nextInt(lineCount);
			if (tree.getLineContent(line) !== model.getLineContent(line)) {
				throw new Divergence(name as TreeFlavor, -1, `${name}: getLineContent(${line}) ${JSON.stringify(tree.getLineContent(line))}, model ${JSON.stringify(model.getLineContent(line))}`);
			}
			const offset = rng.nextInt(raw.length + 1);
			const position = model.getPositionAt(offset);
			if (!tree.getPositionAt(offset).equals(position)) {
				throw new Divergence(name as TreeFlavor, -1, `${name}: getPositionAt(${offset}) ${tree.getPositionAt(offset)}, model ${position}`);
			}
			if (tree.getOffsetAt(position.lineNumber, position.column) !== offset) {
				throw new Divergence(name as TreeFlavor, -1, `${name}: getOffsetAt(${position}) ${tree.getOffsetAt(position.lineNumber, position.column)}, model ${offset}`);
			}
			let a = rng.nextInt(raw.length + 1);
			let b = Math.min(raw.length, a + rng.nextInt(64));
			if (a > b) {
				[a, b] = [b, a];
			}
			const pa = model.getPositionAt(a);
			const pb = model.getPositionAt(b);
			const range = new Range(pa.lineNumber, pa.column, pb.lineNumber, pb.column);
			if (tree.getValueInRange(range) !== raw.substring(a, b)) {
				throw new Divergence(name as TreeFlavor, -1, `${name}: getValueInRange(${range}) differs from the model`);
			}
		}
	}
}

function fullCheck(persistent: PersistentPieceTree, mutable: PieceTreeBase, model: LinesTextBuffer, mode: Mode, rng: Prng, stats: IStats): void {
	const options = { rng, checkLineLength: mode === 'normalized', thorough: true };
	try {
		assertEquivalent(persistent, model, options);
	} catch (error) {
		throw new Divergence('persistent', -1, `persistent: ${(error as Error).message}`);
	}
	try {
		assertEquivalent(mutable, model, options);
	} catch (error) {
		throw new Divergence('mutable', -1, `mutable: ${(error as Error).message}`);
	}
	stats.fullChecks += 2;
}

/** Restores each version and compares it with the text the document had when it was taken. */
function verifyVersions(persistent: PersistentPieceTree, versions: PieceTreeVersion[], raws: string[], indexes: number[], stats: IStats): void {
	const current = persistent.getVersion();
	for (const k of indexes) {
		persistent.restoreVersion(versions[k]);
		const raw = raws[k];
		if (persistent.getLinesRawContent() !== raw) {
			throw new Divergence('versions', -1, `version ${k} (length ${raw.length}) no longer reads as it did: got ${JSON.stringify(persistent.getLinesRawContent().substring(0, 200))}`);
		}
		if (persistent.getLineCount() !== raw.split(/\r\n|\r|\n/).length) {
			throw new Divergence('versions', -1, `version ${k}: getLineCount() ${persistent.getLineCount()}, expected ${raw.split(/\r\n|\r|\n/).length}`);
		}
		if (versions[k].length !== raw.length) {
			throw new Divergence('versions', -1, `version ${k}: version.length ${versions[k].length}, expected ${raw.length}`);
		}
		assertTreeInvariants(persistent);
		stats.versionsVerified++;
	}
	persistent.restoreVersion(current);
}

function runOne(seed: number, stats: IStats): IFailure | null {
	const rng = new Prng(seed ^ 0x9e3779b9);
	const sizeClass = pickSizeClass(rng);
	const mode: Mode = rng.next() < 0.5 ? 'normalized' : 'mixed';
	const scenario = generateScenario({
		seed, mode, opCount: sizeClass.opCount, initialLength: sizeClass.initialLength, insertLength: sizeClass.insertLength, bigEditRate: sizeClass.bigEditRate
	});
	// half of the sessions branch off earlier versions, the other half are undone and redone at the end
	const branching = rng.next() < 0.5;

	const persistent = createTree(scenario, 'persistent') as PersistentPieceTree;
	let mutable = createTree(scenario, 'mutable') as PieceTreeBase;
	let model = createModel(scenario);
	const history = branching ? null : new PieceTreeHistory(persistent, scenario.ops.length + 1);
	const versions: PieceTreeVersion[] = [persistent.getVersion()];
	const raws: string[] = [model.getLinesRawContent()];
	/** Index into raws/versions of the state each applied op led to, for the undo/redo replay. */
	const trail: number[] = [0];

	let opIndex = -1;
	try {
		fullCheck(persistent, mutable, model, mode, rng, stats);
		for (opIndex = 0; opIndex < scenario.ops.length; opIndex++) {
			if (branching && versions.length > 1 && rng.next() < 0.04) {
				const k = rng.nextInt(versions.length);
				persistent.restoreVersion(versions[k]);
				const version = versions[k];
				mutable = rebuildMutable(raws[k], version.eol, version.eolNormalized);
				model = new LinesTextBuffer(raws[k]);
				stats.branches++;
			}

			let op = scenario.ops[opIndex];
			if (persistent.getVersion().eolNormalized) {
				// the generator keeps a normalized buffer's contract (inserted text uses the buffer's EOL,
				// no edit splits a \r\n); after a branch the buffer may have another EOL than the
				// generator assumed, so the fuzzer re-establishes the contract as TextModel would
				if (op.op === 'insert') {
					op = { ...op, text: op.text.replace(/\r\n|\r|\n/g, persistent.getEOL()) };
				}
				op = snapToLineBreaks(op, model.getLinesRawContent());
			}
			const effective = effectiveOp(op, model.getLength());
			history?.pushUndoStop();
			if (effective !== null) {
				applyOpToTree(persistent, effective, mode);
				applyOpToTree(mutable, effective, mode);
				applyOpToModel(model, effective);
				if (effective.op === 'setEOL') {
					stats.setEOLs++;
				} else if (effective.op === 'insert' && effective.text.length > AVERAGE_BUFFER_SIZE) {
					stats.hugeInserts++;
				}
			}
			stats.ops++;
			stats.maxDocumentLength = Math.max(stats.maxDocumentLength, model.getLength());

			const raw = model.getLinesRawContent();
			quickCheck(persistent, mutable, model, raw, rng);
			stats.quickChecks++;
			if ((opIndex + 1) % sizeClass.checkEvery === 0) {
				fullCheck(persistent, mutable, model, mode, rng, stats);
			}

			versions.push(persistent.getVersion());
			raws.push(raw);
			if (effective !== null) {
				// an op that changed nothing added no undo stop either (pushUndoStop dedupes)
				trail.push(versions.length - 1);
			}
			if ((opIndex + 1) % 20 === 0) {
				// a sample of the older versions must still read as they did
				const sample = versions.length <= 40 ? versions.map((_, k) => k) : Array.from({ length: 40 }, () => rng.nextInt(versions.length));
				verifyVersions(persistent, versions, raws, sample, stats);
			}
		}
		opIndex = scenario.ops.length - 1;
		fullCheck(persistent, mutable, model, mode, rng, stats);
		verifyVersions(persistent, versions, raws, versions.map((_, k) => k), stats);

		if (history !== null) {
			// every edit back, one undo stop at a time, then forward again
			for (let k = trail.length - 1; k > 0; k--) {
				if (!history.undo()) {
					throw new Divergence('history', -1, `undo() returned false with ${k} edits left to undo`);
				}
				if (persistent.getLinesRawContent() !== raws[trail[k - 1]]) {
					throw new Divergence('history', -1, `after undoing edit #${k - 1} the document is not what it was before it`);
				}
				stats.undoRedoSteps++;
			}
			if (history.undo()) {
				throw new Divergence('history', -1, 'undo() succeeded past the first undo stop');
			}
			for (let k = 1; k < trail.length; k++) {
				if (!history.redo()) {
					throw new Divergence('history', -1, `redo() returned false with ${trail.length - k} edits left to redo`);
				}
				if (persistent.getLinesRawContent() !== raws[trail[k]]) {
					throw new Divergence('history', -1, `after redoing edit #${k - 1} the document is not what it was after it`);
				}
				stats.undoRedoSteps++;
			}
			if (history.redo()) {
				throw new Divergence('history', -1, 'redo() succeeded past the last edit');
			}
			// then a random walk over the same stops, so that undo after redo (and vice versa) is exercised
			let at = trail.length - 1;
			for (let step = 0; step < 2 * trail.length; step++) {
				const back = rng.next() < 0.5;
				const changed = back ? history.undo() : history.redo();
				const expectedChange = back ? at > 0 : at < trail.length - 1;
				if (changed !== expectedChange) {
					throw new Divergence('history', -1, `${back ? 'undo' : 'redo'}() returned ${changed} at step ${at} of ${trail.length - 1}`);
				}
				at = back ? Math.max(0, at - 1) : Math.min(trail.length - 1, at + 1);
				if (persistent.getLinesRawContent() !== raws[trail[at]]) {
					throw new Divergence('history', -1, `after ${back ? 'undo' : 'redo'}() the document is not the one at step ${at}`);
				}
				if (history.canUndo !== at > 0 || history.canRedo !== at < trail.length - 1) {
					throw new Divergence('history', -1, `canUndo/canRedo ${history.canUndo}/${history.canRedo} at step ${at} of ${trail.length - 1}`);
				}
				stats.undoRedoSteps++;
			}
		}
	} catch (error) {
		const divergence = error instanceof Divergence ? error : new Divergence('persistent', -1, `${(error as Error).stack ?? error}`);
		return describeFailure(seed, sizeClass, scenario, opIndex, divergence);
	} finally {
		stats.scenarios++;
		stats.byMode[mode]++;
		stats.bySize[sizeClass.name]++;
	}
	return null;
}

function describeFailure(seed: number, sizeClass: ISizeClass, scenario: Scenario, opIndex: number, divergence: Divergence): IFailure {
	let shrunk: Scenario | null = null;
	let report: string;
	if (divergence.kind === 'persistent' || divergence.kind === 'mutable') {
		// the single-tree harness reproduces this kind, so it can shrink it
		const flavor: TreeFlavor = divergence.kind;
		const options = { createTree: (s: Scenario) => createTree(s, flavor) };
		const reproduced = runScenario(scenario, options);
		if (reproduced !== null) {
			shrunk = shrinkScenario(scenario, reproduced, options, 20000);
			report = `[${divergence.kind} tree, seed ${seed}, ${sizeClass.name}] ${formatDivergence(scenario, reproduced, shrunk)}`;
		} else {
			report = `[${divergence.kind} tree, seed ${seed}, ${sizeClass.name}] diverged after op #${opIndex} in the fuzzer (branching session; not reproduced by the plain harness):\n  ${divergence.message}\n${JSON.stringify(scenario)}`;
		}
	} else {
		report = `[${divergence.kind}, seed ${seed}, ${sizeClass.name}] failed after op #${opIndex}:\n  ${divergence.message}\nScenario: ${JSON.stringify(scenario)}`;
	}
	return { seed, sizeClass: sizeClass.name, kind: divergence.kind, opIndex, message: divergence.message, scenario, shrunk, report };
}

// ---- workers -------------------------------------------------------------------

type WorkerMessage =
	| { type: 'progress'; stats: IStats }
	| { type: 'failure'; failure: IFailure }
	| { type: 'done'; stats: IStats };

/**
 * A worker runs the scenarios with seeds `seed + offset`, `seed + offset +
 * stride`, ... until its share is done or the deadline passes, reporting
 * progress every second and stopping at the first failure.
 */
function runWorker(options: IOptions): void {
	const send = (message: WorkerMessage) => { process.send!(message); };
	const deadline = options.minutes === null ? Infinity : Date.now() + options.minutes * 60000;
	const stats = emptyStats();
	let sinceReport = emptyStats();
	let lastReport = Date.now();
	for (let k = options.offset; options.scenarios === null || k < options.scenarios; k += options.stride) {
		if (Date.now() >= deadline) {
			break;
		}
		const failure = runOne(options.seed + k, sinceReport);
		if (failure !== null) {
			send({ type: 'failure', failure });
			break;
		}
		if (Date.now() - lastReport > 1000) {
			send({ type: 'progress', stats: sinceReport });
			addStats(stats, sinceReport);
			sinceReport = emptyStats();
			lastReport = Date.now();
		}
	}
	addStats(stats, sinceReport);
	send({ type: 'progress', stats: sinceReport });
	send({ type: 'done', stats });
}

function formatCount(n: number): string {
	return n.toLocaleString('en-US');
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function summary(stats: IStats, failures: IFailure[], elapsedMs: number, options: IOptions): string {
	const lines = [
		`Fuzzed for ${formatDuration(elapsedMs)} with seed ${options.seed} on ${options.workers} worker${options.workers === 1 ? '' : 's'}.`,
		`  ${formatCount(stats.scenarios)} scenarios (${formatCount(stats.byMode.normalized)} normalized, ${formatCount(stats.byMode.mixed)} mixed; ` +
		SIZE_CLASSES.map(c => `${formatCount(stats.bySize[c.name])} ${c.name}`).join(', ') + ')',
		`  ${formatCount(stats.ops)} edits, each followed by a three-way comparison; ${formatCount(stats.fullChecks)} exhaustive comparisons of a tree with the model`,
		`  ${formatCount(stats.versionsVerified)} old versions restored and re-read, ${formatCount(stats.branches)} branches off earlier versions, ${formatCount(stats.undoRedoSteps)} undo/redo steps`,
		`  ${formatCount(stats.setEOLs)} setEOL, ${formatCount(stats.hugeInserts)} inserts above AverageBufferSize, largest document ${formatCount(stats.maxDocumentLength)} characters`,
		failures.length === 0 ? '  No divergence.' : `  ${failures.length} FAILURE${failures.length === 1 ? '' : 'S'}:`,
		...failures.map(f => '\n' + f.report),
	];
	return lines.join('\n') + '\n';
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	if (options.worker) {
		runWorker(options);
		return;
	}

	const start = Date.now();
	const stats = emptyStats();
	const failures: IFailure[] = [];
	let workerCrashes = 0;
	let running = options.workers;
	const progress = () => {
		process.stderr.write(`\r  ${formatCount(stats.scenarios)} scenarios, ${formatCount(stats.ops)} edits, ${failures.length} failure${failures.length === 1 ? '' : 's'}, ${formatDuration(Date.now() - start)}   `);
	};
	const finish = () => {
		process.stderr.write('\n');
		const text = summary(stats, failures, Date.now() - start, options);
		process.stdout.write(text);
		if (options.json !== null) {
			fs.writeFileSync(options.json, JSON.stringify({
				environment: { node: process.version, v8: process.versions.v8, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model.trim(), date: new Date().toISOString() },
				options: { minutes: options.minutes, scenarios: options.scenarios, seed: options.seed, workers: options.workers },
				elapsedMs: Date.now() - start,
				stats,
				failures
			}, null, 2));
			process.stderr.write(`wrote ${options.json}\n`);
		}
		process.exit(failures.length === 0 && workerCrashes === 0 ? 0 : 1);
	};

	process.stderr.write(`Fuzzing with seed ${options.seed} on ${options.workers} worker${options.workers === 1 ? '' : 's'}` +
		(options.scenarios !== null ? `, ${formatCount(options.scenarios)} scenarios` : `, ${options.minutes} minute${options.minutes === 1 ? '' : 's'}`) + '\n');
	for (let w = 0; w < options.workers; w++) {
		const args = [
			'--worker', '--seed', String(options.seed), '--stride', String(options.workers), '--offset', String(w),
			...(options.minutes !== null ? ['--minutes', String(options.minutes)] : []),
			...(options.scenarios !== null ? ['--scenarios', String(options.scenarios)] : []),
		];
		const child = childProcess.fork(process.argv[1], args, { execArgv: process.execArgv, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
		child.on('message', (message: WorkerMessage) => {
			if (message.type === 'progress') {
				addStats(stats, message.stats);
				progress();
			} else if (message.type === 'failure') {
				failures.push(message.failure);
			}
		});
		child.on('exit', (code, signal) => {
			if (code !== 0) {
				workerCrashes++;
				process.stderr.write(`\nworker ${w} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}\n`);
			}
			if (--running === 0) {
				finish();
			}
		});
	}
}

main();
