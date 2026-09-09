/*
 * Long-running differential fuzzing of PieceTreeBase against the array-of-lines model.
 *
 *   npm run fuzz                          # all cores but one, 10 minutes
 *   npm run fuzz -- --minutes 60          # a longer campaign
 *   npm run fuzz -- --scenarios 2000      # a fixed amount of work instead of a time budget
 *   npm run fuzz -- --seed 7 --workers 1  # reproducible single-process run
 *   npm run fuzz -- --json fuzz.json      # also write the statistics (and any failure) as JSON
 *
 * Every scenario is a random editing session (src/test/differential.ts's
 * generator) applied step by step to PieceTreeBase and LinesTextBuffer. After
 * every edit the two must agree on the text, the line count and a sample of
 * queries; periodically, and at the end, every public query is compared
 * exhaustively (assertEquivalent), including getCharCode, getNearestChunk,
 * forEachLine, and compact().
 *
 * A divergence is shrunk with the harness's delta debugging and printed as a
 * scenario that can be pinned in differential.test.ts. Seeds make every run
 * reproducible: scenario k of a run with --seed S is generated from S + k.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import {
	Mode, Scenario, formatDivergence, generateScenario, runScenario, shrinkScenario
} from '../test/differential';
import { Prng } from '../test/prng';

interface Options {
	minutes: number | null;
	scenarios: number | null;
	seed: number;
	workers: number;
	json: string | null;
	worker: boolean;
	stride: number;
	offset: number;
}

const HELP = `Differential fuzzing of PieceTreeBase against an array-of-lines model.

Options:
  --minutes <m>     run for m minutes (default 10, unless --scenarios is given)
  --scenarios <n>   run exactly n scenarios instead of a time budget
  --seed <s>        seed of the campaign (default: random); scenario k uses seed s + k
  --workers <w>     parallel processes (default: all cores but one)
  --json <file>     write the statistics, and any failure, as JSON
  --help
`;

function parseArgs(argv: string[]): Options {
	const options: Options = {
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

interface SizeClass {
	readonly name: string;
	readonly initialLength: number;
	readonly opCount: number;
	readonly insertLength: number;
	readonly bigEditRate: number;
	readonly checkEvery: number;
	readonly weight: number;
}

const SIZE_CLASSES: readonly SizeClass[] = [
	{ name: 'tiny', initialLength: 40, opCount: 300, insertLength: 4, bigEditRate: 0.02, checkEvery: 1, weight: 25 },
	{ name: 'small', initialLength: 400, opCount: 300, insertLength: 12, bigEditRate: 0.04, checkEvery: 1, weight: 25 },
	{ name: 'medium', initialLength: 6000, opCount: 250, insertLength: 40, bigEditRate: 0.05, checkEvery: 5, weight: 20 },
	{ name: 'large', initialLength: 80000, opCount: 150, insertLength: 200, bigEditRate: 0.06, checkEvery: 25, weight: 10 },
	// sequential typing that fills and rotates the 64KB change buffer
	{ name: 'typing', initialLength: 0, opCount: 400, insertLength: 8, bigEditRate: 0.01, checkEvery: 20, weight: 10 },
	// big edits of up to insertLength * 40 characters: above AverageBufferSize, the inserted text gets buffers of its own
	{ name: 'huge inserts', initialLength: 2000, opCount: 60, insertLength: 2500, bigEditRate: 0.3, checkEvery: 5, weight: 10 },
];

function pickSizeClass(rng: Prng): SizeClass {
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

interface Stats {
	scenarios: number;
	ops: number;
	fullChecks: number;
	setEOLs: number;
	hugeInserts: number;
	byMode: Record<Mode, number>;
	bySize: Record<string, number>;
}

function emptyStats(): Stats {
	const bySize: Record<string, number> = {};
	for (const c of SIZE_CLASSES) {
		bySize[c.name] = 0;
	}
	return {
		scenarios: 0, ops: 0, fullChecks: 0, setEOLs: 0, hugeInserts: 0,
		byMode: { normalized: 0, mixed: 0 }, bySize
	};
}

function addStats(into: Stats, from: Stats): void {
	into.scenarios += from.scenarios;
	into.ops += from.ops;
	into.fullChecks += from.fullChecks;
	into.setEOLs += from.setEOLs;
	into.hugeInserts += from.hugeInserts;
	into.byMode.normalized += from.byMode.normalized;
	into.byMode.mixed += from.byMode.mixed;
	for (const name of Object.keys(from.bySize)) {
		into.bySize[name] = (into.bySize[name] ?? 0) + from.bySize[name];
	}
}

interface Failure {
	seed: number;
	sizeClass: string;
	opIndex: number;
	message: string;
	scenario: Scenario;
	shrunk: Scenario | null;
	report: string;
}

const AVERAGE_BUFFER_SIZE = 65535;

function runOne(seed: number, stats: Stats): Failure | null {
	const rng = new Prng(seed ^ 0x9e3779b9);
	const sizeClass = pickSizeClass(rng);
	const mode: Mode = rng.next() < 0.5 ? 'normalized' : 'mixed';
	const scenario = generateScenario({
		seed, mode, opCount: sizeClass.opCount, initialLength: sizeClass.initialLength, insertLength: sizeClass.insertLength, bigEditRate: sizeClass.bigEditRate
	});

	stats.scenarios++;
	stats.ops += scenario.ops.length;
	stats.byMode[mode]++;
	stats.bySize[sizeClass.name]++;
	for (const op of scenario.ops) {
		if (op.op === 'setEOL') {
			stats.setEOLs++;
		} else if (op.op === 'insert' && op.text.length > AVERAGE_BUFFER_SIZE) {
			stats.hugeInserts++;
		}
	}

	const divergence = runScenario(scenario, { checkEvery: sizeClass.checkEvery, thorough: true, compact: true });
	stats.fullChecks += 1 + Math.ceil(scenario.ops.length / sizeClass.checkEvery);
	if (divergence === null) {
		return null;
	}

	const shrunk = shrinkScenario(scenario, divergence, { checkEvery: 1, thorough: true, compact: true }, 20000);
	const report = `[seed ${seed}, ${sizeClass.name}] ${formatDivergence(scenario, divergence, shrunk)}`;
	return {
		seed,
		sizeClass: sizeClass.name,
		opIndex: divergence.opIndex,
		message: divergence.error.message,
		scenario,
		shrunk,
		report
	};
}

type WorkerMessage =
	| { type: 'progress'; stats: Stats }
	| { type: 'failure'; failure: Failure }
	| { type: 'done'; stats: Stats };

function runWorker(options: Options): void {
	const send = (message: WorkerMessage): void => {
		if (process.send === undefined) {
			throw new Error('worker started without an IPC channel');
		}
		process.send(message);
	};
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

function summary(stats: Stats, failures: Failure[], elapsedMs: number, options: Options): string {
	const lines = [
		`Fuzzed for ${formatDuration(elapsedMs)} with seed ${options.seed} on ${options.workers} worker${options.workers === 1 ? '' : 's'}.`,
		`  ${formatCount(stats.scenarios)} scenarios (${formatCount(stats.byMode.normalized)} normalized, ${formatCount(stats.byMode.mixed)} mixed; ` +
		SIZE_CLASSES.map(c => `${formatCount(stats.bySize[c.name])} ${c.name}`).join(', ') + ')',
		`  ${formatCount(stats.ops)} edits; ${formatCount(stats.fullChecks)} exhaustive comparisons of the tree with the model`,
		`  ${formatCount(stats.setEOLs)} setEOL, ${formatCount(stats.hugeInserts)} inserts above AverageBufferSize`,
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
	const failures: Failure[] = [];
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
