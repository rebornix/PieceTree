import * as fs from 'fs';
import * as path from 'path';

/*
 * Renders the benchmark results as SVG bar charts, one per family of
 * benchmarks (memory, file opening, editing, ...), in the spirit of the charts
 * of the blog post. Each chart is a grid: a column per document, a row per
 * workload, and in every cell the two buffers side by side. Values differ by
 * orders of magnitude between a 1 MB and a 180 MB file, so every cell has its
 * own linear scale and carries its numbers; what the chart shows is the
 * comparison within a cell and how it changes as the file grows.
 *
 * Plain hand-written SVG: no dependencies, renders in GitHub READMEs.
 */

export interface IChartDocument {
	name: string;
	bytes: number;
	lines: number;
}

export interface IChartResult {
	document: string;
	benchmark: string;
	implementation: string;
	/** ms, or bytes for the memory benchmark */
	median: number;
}

export interface IChartInput {
	documents: IChartDocument[];
	results: IChartResult[];
	/** Rendered under the chart, e.g. the environment and the number of runs. */
	note?: string;
}

/** What `npm run bench -- --json <path>` writes (the parts the charts need). */
export interface IBenchReport {
	environment: { node: string; v8: string; platform: string; arch: string; cpu?: string; date: string };
	options: { iterations: number; edits: number; seed: number };
	documents: IChartDocument[];
	results: IChartResult[];
}

/**
 * Chart input for a saved report, optionally restricted to (and ordered by)
 * the given document names.
 */
export function chartInput(report: IBenchReport, documentNames?: string[]): IChartInput {
	let documents = report.documents;
	if (documentNames) {
		documents = documentNames.map(name => {
			const doc = report.documents.find(d => d.name === name);
			if (!doc) {
				throw new Error(`No document "${name}" in the report; it has: ${report.documents.map(d => d.name).join(', ')}`);
			}
			return doc;
		});
	}
	const env = report.environment;
	const v8 = env.v8.split('-')[0];
	const runs = report.options.iterations;
	return {
		documents,
		results: report.results.filter(r => documents.some(d => d.name === r.document)),
		note: `Node ${env.node}, V8 ${v8}, ${env.cpu ?? env.arch}, ${env.platform}. ` +
			`Median of ${runs} run${runs === 1 ? '' : 's'} after one warm-up, ${env.date.substring(0, 10)}.`
	};
}

interface IChartFamily {
	file: string;
	title: string;
	/** Benchmarks whose name starts with this belong to the family; the rest of the name labels the row. */
	prefix: string;
	unit: 'ms' | 'bytes';
}

export const CHART_FAMILIES: IChartFamily[] = [
	{ file: 'memory.svg', title: 'Memory usage after load', prefix: 'Memory usage after load', unit: 'bytes' },
	{ file: 'file-opening.svg', title: 'File opening', prefix: 'File opening', unit: 'ms' },
	{ file: 'editing.svg', title: 'Editing', prefix: 'Editing: ', unit: 'ms' },
	{ file: 'reading-all-lines.svg', title: 'Reading all lines', prefix: 'Reading: all lines ', unit: 'ms' },
	{ file: 'reading-windows.svg', title: 'Reading 10 windows of 100 lines', prefix: 'Reading: 10 windows of 100 lines ', unit: 'ms' },
	{ file: 'saving.svg', title: 'Saving the full text', prefix: 'Saving: full text ', unit: 'ms' },
];

const IMPLEMENTATIONS = [
	{ name: 'line array', color: '#9aa0a6' },
	{ name: 'piece tree', color: '#0078d4' },
];

const CELL_WIDTH = 150;
const CELL_HEIGHT = 140;
const BAR_WIDTH = 38;
const BAR_GAP = 14;
const HEADER_HEIGHT = 56;
const TITLE_HEIGHT = 44;
const FOOTER_HEIGHT = 28;
const FONT = 'font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"';

function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatValue(value: number, unit: 'ms' | 'bytes'): string {
	if (!isFinite(value)) {
		return 'n/a';
	}
	if (unit === 'bytes') {
		const mib = value / (1024 * 1024);
		return mib >= 1 ? `${mib.toFixed(1)} MB` : `${(value / 1024).toFixed(0)} KB`;
	}
	if (value >= 1000) {
		return `${(value / 1000).toFixed(1)} s`;
	}
	if (value >= 100) {
		return `${value.toFixed(0)} ms`;
	}
	if (value >= 10) {
		return `${value.toFixed(1)} ms`;
	}
	if (value >= 1) {
		return `${value.toFixed(2)} ms`;
	}
	return `${value.toFixed(3)} ms`;
}

function formatComparison(lineArray: number, pieceTree: number, unit: 'ms' | 'bytes'): string {
	if (!(lineArray > 0) || !(pieceTree > 0)) {
		return '';
	}
	const ratio = lineArray / pieceTree;
	const better = ratio >= 1;
	const factor = better ? ratio : 1 / ratio;
	const digits = factor >= 10 ? 0 : 1;
	const text = factor.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
	if (unit === 'bytes') {
		return `${text}x ${better ? 'less' : 'more'} memory`;
	}
	return `${text}x ${better ? 'faster' : 'slower'}`;
}

function formatSize(bytes: number): string {
	const mib = bytes / (1024 * 1024);
	return mib >= 100 ? `${mib.toFixed(0)} MB` : mib >= 1 ? `${mib.toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function formatLines(lines: number): string {
	if (lines >= 1_000_000) {
		return `${(lines / 1_000_000).toFixed(1)}M lines`;
	}
	if (lines >= 1000) {
		return `${Math.round(lines / 1000)}k lines`;
	}
	return `${lines} lines`;
}

/** Rough width of a text in the chart's fonts; the SVG has no layout engine to ask. */
function textWidth(text: string, fontSize: number, bold: boolean = false): number {
	return text.length * fontSize * (bold ? 0.6 : 0.55);
}

/** Break a label into at most two lines of roughly `max` characters. */
function wrapLabel(name: string, max: number): string[] {
	if (name.length <= max) {
		return [name];
	}
	const words = name.split(/(?<=[ \-_.])/);
	const lines: string[] = [''];
	for (const word of words) {
		if (lines[lines.length - 1].length + word.length > max && lines[lines.length - 1].length > 0) {
			lines.push('');
		}
		lines[lines.length - 1] += word;
	}
	if (lines.length > 2) {
		lines.length = 2;
		lines[1] = lines[1].substring(0, Math.max(0, max - 1)) + '…';
	}
	return lines.map(l => l.trim());
}

export function renderChart(input: IChartInput, family: IChartFamily): string | undefined {
	const rows: { label: string; benchmark: string }[] = [];
	for (const result of input.results) {
		if (result.benchmark.startsWith(family.prefix) && !rows.some(r => r.benchmark === result.benchmark)) {
			rows.push({ label: result.benchmark.substring(family.prefix.length), benchmark: result.benchmark });
		}
	}
	const documents = input.documents.filter(doc => input.results.some(r => r.document === doc.name && r.benchmark.startsWith(family.prefix)));
	if (rows.length === 0 || documents.length === 0) {
		return undefined;
	}

	const rowLabels = rows.map(r => wrapLabel(r.label, 24));
	const rowLabelWidth = Math.max(0, ...rowLabels.flat().map(line => textWidth(line, 12, true)));
	const left = 24 + (rowLabelWidth > 0 ? rowLabelWidth + 16 : 0);
	// wide enough for the title and the legend even with a single document
	const width = Math.max(560, left + documents.length * CELL_WIDTH + 24);
	const gridTop = TITLE_HEIGHT + HEADER_HEIGHT;
	const height = gridTop + rows.length * CELL_HEIGHT + FOOTER_HEIGHT + (input.note ? 16 : 0);
	const unitLabel = family.unit === 'bytes' ? 'heap retained by the buffer' : 'milliseconds';

	const out: string[] = [];
	out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${FONT} font-size="12">`);
	out.push(`<rect width="${width}" height="${height}" fill="#ffffff" rx="6"/>`);

	// title and legend
	out.push(`<text x="24" y="28" font-size="17" font-weight="600" fill="#1f2328">${escapeXml(family.title)}</text>`);
	out.push(`<text x="24" y="46" font-size="11" fill="#656d76">${escapeXml(unitLabel)}, lower is better; every cell has its own scale</text>`);
	let legendX = width - 24;
	for (let i = IMPLEMENTATIONS.length - 1; i >= 0; i--) {
		const impl = IMPLEMENTATIONS[i];
		legendX -= textWidth(impl.name, 12);
		out.push(`<text x="${legendX}" y="28" fill="#1f2328">${escapeXml(impl.name)}</text>`);
		legendX -= 18;
		out.push(`<rect x="${legendX}" y="17" width="12" height="12" rx="2" fill="${impl.color}"/>`);
		legendX -= 18;
	}

	// column headers
	documents.forEach((doc, col) => {
		const cx = left + col * CELL_WIDTH + CELL_WIDTH / 2;
		const nameLines = wrapLabel(doc.name, 22);
		let y = TITLE_HEIGHT + 20;
		if (nameLines.length === 1) {
			y += 7;
		}
		for (const line of nameLines) {
			out.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-weight="600" fill="#1f2328">${escapeXml(line)}</text>`);
			y += 15;
		}
		out.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-size="11" fill="#656d76">${escapeXml(`${formatSize(doc.bytes)} · ${formatLines(doc.lines)}`)}</text>`);
	});

	// cells
	rows.forEach((row, rowIndex) => {
		const top = gridTop + rowIndex * CELL_HEIGHT;
		const baseline = top + CELL_HEIGHT - 30;
		const labelLines = rowLabels[rowIndex];
		labelLines.forEach((line, i) => {
			const y = top + CELL_HEIGHT / 2 + (i - (labelLines.length - 1) / 2) * 15;
			out.push(`<text x="${left - 16}" y="${y}" text-anchor="end" font-weight="600" fill="#1f2328">${escapeXml(line)}</text>`);
		});
		out.push(`<line x1="${left}" y1="${top}" x2="${left + documents.length * CELL_WIDTH}" y2="${top}" stroke="#d0d7de" stroke-width="1"/>`);

		documents.forEach((doc, col) => {
			const x0 = left + col * CELL_WIDTH;
			const values = IMPLEMENTATIONS.map(impl => {
				const result = input.results.find(r => r.document === doc.name && r.benchmark === row.benchmark && r.implementation === impl.name);
				return result ? result.median : NaN;
			});
			const max = Math.max(...values.filter(v => isFinite(v)), 0);
			const maxBarHeight = CELL_HEIGHT - 62;
			const groupWidth = IMPLEMENTATIONS.length * BAR_WIDTH + (IMPLEMENTATIONS.length - 1) * BAR_GAP;
			let x = x0 + (CELL_WIDTH - groupWidth) / 2;

			out.push(`<line x1="${x0 + 16}" y1="${baseline}" x2="${x0 + CELL_WIDTH - 16}" y2="${baseline}" stroke="#8c959f" stroke-width="1"/>`);
			values.forEach((value, i) => {
				if (isFinite(value)) {
					const barHeight = max > 0 ? Math.max(1.5, (value / max) * maxBarHeight) : 1.5;
					out.push(`<rect x="${x}" y="${(baseline - barHeight).toFixed(1)}" width="${BAR_WIDTH}" height="${barHeight.toFixed(1)}" fill="${IMPLEMENTATIONS[i].color}"/>`);
					out.push(`<text x="${x + BAR_WIDTH / 2}" y="${(baseline - barHeight - 5).toFixed(1)}" text-anchor="middle" font-size="11" fill="#1f2328">${escapeXml(formatValue(value, family.unit))}</text>`);
				} else {
					out.push(`<text x="${x + BAR_WIDTH / 2}" y="${baseline - 5}" text-anchor="middle" font-size="11" fill="#8c959f">n/a</text>`);
				}
				x += BAR_WIDTH + BAR_GAP;
			});

			const comparison = formatComparison(values[0], values[1], family.unit);
			if (comparison) {
				out.push(`<text x="${x0 + CELL_WIDTH / 2}" y="${baseline + 17}" text-anchor="middle" font-size="11" fill="#656d76">${escapeXml(comparison)}</text>`);
			}
		});
	});

	if (input.note) {
		out.push(`<text x="24" y="${height - 12}" font-size="10" fill="#8c959f">${escapeXml(input.note)}</text>`);
	}
	out.push('</svg>');
	return out.join('\n') + '\n';
}

/** Writes one SVG per benchmark family that has results; returns the files written. */
export function renderCharts(input: IChartInput, outDir: string): string[] {
	fs.mkdirSync(outDir, { recursive: true });
	const written: string[] = [];
	for (const family of CHART_FAMILIES) {
		const svg = renderChart(input, family);
		if (svg) {
			const file = path.join(outDir, family.file);
			fs.writeFileSync(file, svg);
			written.push(file);
		}
	}
	return written;
}
