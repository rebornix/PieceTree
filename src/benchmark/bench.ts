import * as fs from 'fs';
import * as os from 'os';
import { Prng } from '../test/prng';
import { IBenchBuffer, IBufferImplementation, implementations, pieceTreeImplementation } from './adapters';
import {
	CORPUS_FILES, IDocument, SYNTHETIC_SPECS, corpusPath, fileDocument, repeatDocument, syntheticDocument
} from './corpus';
import { canMeasureMemory, measureRetainedHeap, stats, timeMs } from './measure';
import { IEdit, generateRandomEdits, generateSequentialInserts, generateWindowStarts, splitIntoLines } from './workloads';

/*
 * Reproduces the comparisons of the VS Code blog post "Text Buffer
 * Reimplementation" (https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation)
 * between the old line array and the piece tree, using the workloads of the
 * benchmarks VS Code had at the time (src/vs/editor/test/common/model/benchmark
 * at 1.21.0):
 *
 *   1. memory usage after loading a file
 *   2. file opening time (building the buffer from 64 KB chunks)
 *   3. editing: 1000 random edits, 1000 sequential inserts
 *   4. reading: getLineContent for all lines / for 10 windows of 100 lines, after those edits
 *   5. saving: reading back the full text after those edits
 *
 * Usage: npm run bench -- [options]     (see --help)
 */

interface IOptions {
	sizes: string[];
	corpus: boolean;
	files: string[];
	huge: boolean;
	iterations: number;
	edits: number;
	seed: number;
	json: string | undefined;
}

const HELP = `Usage: npm run bench -- [options]

  --sizes <list>      synthetic documents to run: ${Object.keys(SYNTHETIC_SPECS).join(', ')} or "none"
                      (default: small,medium,large)
  --corpus            also run the blog post's real files from bench-corpus/ (npm run bench:corpus downloads them)
  --file <path>       also run an arbitrary file (repeatable)
  --huge              add the 54 MB synthetic document (unless --sizes none) and, with --corpus, "checker.ts x 128";
                      takes several minutes
  --iterations <n>    timed repetitions per benchmark, the median is reported (default: 5)
  --edits <n>         number of edits per editing workload (default: 1000)
  --seed <n>          seed for the generated documents and edits (default: 2018)
  --json <path>       also write all samples and environment info as JSON
  --smoke             shorthand for --sizes tiny --iterations 1 (CI check that the benchmark still runs)
`;

function parseArgs(argv: string[]): IOptions {
	const options: IOptions = {
		sizes: ['small', 'medium', 'large'],
		corpus: false,
		files: [],
		huge: false,
		iterations: 5,
		edits: 1000,
		seed: 2018,
		json: undefined
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			if (i + 1 >= argv.length) {
				throw new Error(`${arg} needs a value`);
			}
			return argv[++i];
		};
		switch (arg) {
			case '--sizes': options.sizes = value().split(',').filter(s => s !== 'none' && s.length > 0); break;
			case '--corpus': options.corpus = true; break;
			case '--file': options.files.push(value()); break;
			case '--huge': options.huge = true; break;
			case '--iterations': options.iterations = parseInt(value(), 10); break;
			case '--edits': options.edits = parseInt(value(), 10); break;
			case '--seed': options.seed = parseInt(value(), 10); break;
			case '--json': options.json = value(); break;
			case '--smoke': options.sizes = ['tiny']; options.iterations = 1; break;
			case '--help': case '-h': process.stdout.write(HELP); process.exit(0);
			default: throw new Error(`Unknown option ${arg}\n\n${HELP}`);
		}
	}
	for (const size of options.sizes) {
		if (!SYNTHETIC_SPECS[size]) {
			throw new Error(`Unknown size "${size}"; known: ${Object.keys(SYNTHETIC_SPECS).join(', ')}`);
		}
	}
	if (options.huge && !options.sizes.includes('huge') && options.sizes.length > 0) {
		options.sizes.push('huge');
	}
	return options;
}

function loadDocuments(options: IOptions): IDocument[] {
	const documents: IDocument[] = [];
	for (const size of options.sizes) {
		progress(`generating ${SYNTHETIC_SPECS[size].name}`);
		documents.push(syntheticDocument(SYNTHETIC_SPECS[size], options.seed));
	}
	if (options.corpus) {
		let checker: IDocument | undefined;
		for (const file of CORPUS_FILES) {
			const filePath = corpusPath(file);
			if (!fs.existsSync(filePath)) {
				throw new Error(`${filePath} is missing; run "npm run bench:corpus" first`);
			}
			const doc = fileDocument(filePath);
			documents.push(doc);
			if (file.file === 'checker.ts') {
				checker = doc;
			}
		}
		if (options.huge && checker) {
			documents.push(repeatDocument(checker, 128));
		}
	}
	for (const filePath of options.files) {
		documents.push(fileDocument(filePath));
	}
	return documents;
}

/* ------------------------------------------------------------------------- */

interface IResult {
	document: string;
	benchmark: string;
	implementation: string;
	/** ms, or bytes for the memory benchmark */
	samples: number[];
	median: number;
	/** A value derived from what the benchmark read, compared across implementations. */
	checksum: number;
}

const BENCHMARKS = {
	memory: 'Memory usage after load',
	open: 'File opening',
	edits: (kind: string) => `Editing: ${kind}`,
	readAll: (kind: string) => `Reading: all lines after ${kind}`,
	readWindows: (kind: string) => `Reading: 10 windows of 100 lines after ${kind}`,
	save: (kind: string) => `Saving: full text after ${kind}`
};

function progress(message: string): void {
	process.stderr.write(`  ${message}\n`);
}

function readLines(buffer: IBenchBuffer, from: number, to: number): number {
	// the same "use the string" trick as the original benchmark, folded into a checksum
	let checksum = 0;
	for (let lineNumber = from; lineNumber <= to; lineNumber++) {
		const str = buffer.getLineContent(lineNumber);
		checksum = (checksum + str.length * 31 + (str.length > 0 ? str.charCodeAt(0) : 0)) | 0;
	}
	return checksum;
}

function applyEdits(buffer: IBenchBuffer, edits: IEdit[]): number {
	// one applyEdits call per edit, as the original benchmark did (that is how typing arrives)
	let checksum = 0;
	for (let i = 0; i < edits.length; i++) {
		const applied = buffer.applyEdit(edits[i].range, edits[i].text);
		checksum = (checksum + applied.rangeOffset + applied.rangeLength * 31
			+ (applied.oldText.length > 0 ? applied.oldText.charCodeAt(0) : 0)) | 0;
	}
	return checksum;
}

interface ITimedBenchmark {
	name: string;
	/** Unmeasured preparation of a freshly built buffer. */
	prepare?: (buffer: IBenchBuffer) => void;
	/** The measured part; returns a checksum. */
	run: (buffer: IBenchBuffer) => number;
}

class Runner {
	readonly results: IResult[] = [];

	constructor(private readonly options: IOptions) { }

	private record(document: IDocument, benchmark: string, implementation: IBufferImplementation, samples: number[], checksum: number): void {
		this.results.push({
			document: document.name,
			benchmark,
			implementation: implementation.name,
			samples,
			median: stats(samples).median,
			checksum
		});
	}

	private checkAgreement(document: IDocument, benchmark: string): void {
		const rows = this.results.filter(r => r.document === document.name && r.benchmark === benchmark);
		const checksums = new Set(rows.map(r => r.checksum));
		if (checksums.size > 1) {
			throw new Error(`Implementations disagree on "${benchmark}" for ${document.name}: ` +
				rows.map(r => `${r.implementation}=${r.checksum}`).join(', '));
		}
	}

	runDocument(document: IDocument): void {
		process.stderr.write(`${document.name} (${formatBytes(document.bytes)}, ${document.lines.toLocaleString('en-US')} lines)\n`);

		// 1. memory
		if (canMeasureMemory()) {
			for (const implementation of implementations) {
				let lineCount = 0;
				const bytes = measureRetainedHeap(() => {
					const buffer = implementation.build(document.load());
					lineCount = buffer.getLineCount();
					return buffer;
				});
				this.record(document, BENCHMARKS.memory, implementation, [bytes], lineCount);
			}
			this.checkAgreement(document, BENCHMARKS.memory);
			progress(BENCHMARKS.memory);
		}

		// 2. file opening: the chunks are already in memory (as fs.readFile would deliver them),
		// building the buffer from them is what is timed
		const chunks = document.load();
		this.runTimed(document, chunks, {
			name: BENCHMARKS.open,
			run: buffer => buffer.getLineCount()
		}, /* timeBuild */ true);

		// 3. + 4. + 5. editing, then reading and saving the edited buffer
		const eol = pieceTreeImplementation.build(chunks).getEOL();
		const rng = new Prng(this.options.seed);
		const lines = splitIntoLines(chunks);
		const editKinds: { kind: string; edits: IEdit[]; lineCountAfter: number }[] = [];
		{
			const model = lines.slice();
			const edits = generateRandomEdits(model, this.options.edits, rng);
			editKinds.push({ kind: `${this.options.edits} random edits`, edits, lineCountAfter: model.length });
		}
		{
			const model = lines.slice();
			const edits = generateSequentialInserts(model, this.options.edits, eol, rng);
			editKinds.push({ kind: `${this.options.edits} sequential inserts`, edits, lineCountAfter: model.length });
		}

		for (const { kind, edits, lineCountAfter } of editKinds) {
			const windows = generateWindowStarts(lineCountAfter, 10, 100, rng);

			this.runTimed(document, chunks, {
				name: BENCHMARKS.edits(kind),
				run: buffer => (applyEdits(buffer, edits) + buffer.getLineCount() * 7) | 0
			});

			this.runTimed(document, chunks, {
				name: BENCHMARKS.readAll(kind),
				prepare: buffer => applyEdits(buffer, edits),
				run: buffer => readLines(buffer, 1, buffer.getLineCount())
			});

			this.runTimed(document, chunks, {
				name: BENCHMARKS.readWindows(kind),
				prepare: buffer => applyEdits(buffer, edits),
				run: buffer => {
					let checksum = 0;
					const lineCount = buffer.getLineCount();
					for (const start of windows) {
						checksum = (checksum + readLines(buffer, start, Math.min(lineCount, start + 99))) | 0;
					}
					return checksum;
				}
			});

			this.runTimed(document, chunks, {
				name: BENCHMARKS.save(kind),
				prepare: buffer => applyEdits(buffer, edits),
				run: buffer => {
					const value = buffer.getValue();
					// charCodeAt flattens a rope, so that a concatenation-based getValue pays its full price here
					return (value.length * 31 + value.charCodeAt(value.length >> 1)) | 0;
				}
			});
		}
	}

	private runTimed(document: IDocument, chunks: string[], benchmark: ITimedBenchmark, timeBuild: boolean = false): void {
		const samples = new Map<IBufferImplementation, number[]>();
		const checksums = new Map<IBufferImplementation, number>();
		for (const implementation of implementations) {
			samples.set(implementation, []);
		}

		// one warm-up round, then the timed rounds; implementations are interleaved so
		// that drift (JIT tiers, heap state) affects them alike
		for (let iteration = -1; iteration < this.options.iterations; iteration++) {
			for (const implementation of implementations) {
				let buffer!: IBenchBuffer;
				let checksum = 0;
				let ms: number;
				if (timeBuild) {
					ms = timeMs(() => {
						buffer = implementation.build(chunks);
					});
					checksum = benchmark.run(buffer);
				} else {
					buffer = implementation.build(chunks);
					benchmark.prepare?.(buffer);
					ms = timeMs(() => {
						checksum = benchmark.run(buffer);
					});
				}
				if (iteration >= 0) {
					samples.get(implementation)!.push(ms);
				}
				checksums.set(implementation, checksum);
			}
		}

		for (const implementation of implementations) {
			this.record(document, benchmark.name, implementation, samples.get(implementation)!, checksums.get(implementation)!);
		}
		this.checkAgreement(document, benchmark.name);
		progress(benchmark.name);
	}
}

/* ------------------------------------------------------------------------- */

function formatBytes(bytes: number): string {
	if (!isFinite(bytes)) {
		return 'n/a';
	}
	const mib = bytes / (1024 * 1024);
	return mib >= 1 ? `${mib.toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function formatMs(ms: number): string {
	if (ms < 1) {
		return ms.toFixed(3);
	}
	if (ms < 100) {
		return ms.toFixed(2);
	}
	return ms.toFixed(1);
}

function formatRatio(baseline: number, value: number): string {
	if (!(baseline > 0) || !(value > 0)) {
		return '';
	}
	const ratio = baseline / value;
	return ratio >= 1 ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)}x faster` : `${(1 / ratio).toFixed(1 / ratio >= 10 ? 0 : 1)}x slower`;
}

function report(options: IOptions, documents: IDocument[], results: IResult[]): string {
	const out: string[] = [];
	const names = implementations.map(i => i.name);
	const benchmarks: string[] = [];
	for (const r of results) {
		if (!benchmarks.includes(r.benchmark)) {
			benchmarks.push(r.benchmark);
		}
	}

	out.push(`# Text buffer benchmark`);
	out.push('');
	out.push(`Node ${process.version}, V8 ${process.versions.v8}, ${os.cpus()[0]?.model.trim() ?? os.arch()}, ${os.platform()}. ` +
		`Median of ${options.iterations} run${options.iterations === 1 ? '' : 's'} after one warm-up; ${options.edits} edits per editing workload; seed ${options.seed}.`);
	out.push('');
	out.push('| document | size | lines |');
	out.push('|---|---:|---:|');
	for (const doc of documents) {
		out.push(`| ${doc.name} | ${formatBytes(doc.bytes)} | ${doc.lines.toLocaleString('en-US')} |`);
	}

	for (const benchmark of benchmarks) {
		const isMemory = benchmark === BENCHMARKS.memory;
		out.push('');
		out.push(`## ${benchmark}${isMemory ? '' : ' (ms)'}`);
		out.push('');
		out.push(`| document | ${names.join(' | ')} | piece tree vs line array |`);
		out.push(`|---|${names.map(() => '---:').join('|')}|---|`);
		for (const doc of documents) {
			const row = names.map(name => results.find(r => r.document === doc.name && r.benchmark === benchmark && r.implementation === name));
			if (row.some(r => r === undefined)) {
				continue;
			}
			const values = row.map(r => r!.median);
			const cells = values.map(v => isMemory ? formatBytes(v) : formatMs(v));
			const comparison = isMemory
				? (values[0] > 0 && values[1] > 0 ? `${(values[1] / values[0] * 100).toFixed(0)}% of line array` : '')
				: formatRatio(values[0], values[1]);
			out.push(`| ${doc.name} | ${cells.join(' | ')} | ${comparison} |`);
		}
	}
	return out.join('\n') + '\n';
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	if (!canMeasureMemory()) {
		process.stderr.write('note: run with node --expose-gc to include the memory benchmark\n');
	}
	const documents = loadDocuments(options);
	const runner = new Runner(options);
	for (const document of documents) {
		runner.runDocument(document);
	}

	const markdown = report(options, documents, runner.results);
	process.stdout.write('\n' + markdown);

	if (options.json) {
		const json = {
			environment: {
				node: process.version,
				v8: process.versions.v8,
				platform: os.platform(),
				arch: os.arch(),
				cpu: os.cpus()[0]?.model.trim(),
				date: new Date().toISOString()
			},
			options,
			documents: documents.map(d => ({ name: d.name, bytes: d.bytes, lines: d.lines })),
			results: runner.results
		};
		fs.writeFileSync(options.json, JSON.stringify(json, null, 2));
		process.stderr.write(`wrote ${options.json}\n`);
	}
}

main();
