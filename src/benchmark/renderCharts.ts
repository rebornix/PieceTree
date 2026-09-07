import * as fs from 'fs';
import * as path from 'path';
import { IBenchReport, chartInput, renderCharts } from './charts';

/*
 * Renders the charts for a benchmark run saved with `npm run bench -- --json <path>`,
 * so that a long run does not have to be repeated to change the charts.
 *
 * Usage: npm run bench:charts -- <results.json> [out-dir] [--documents <list>]
 */

const HELP = `Usage: npm run bench:charts -- <results.json> [out-dir] [options]

  results.json        written by "npm run bench -- --json <path>"
  out-dir             where to write the SVG files (default: the directory of results.json)
  --documents <list>  comma-separated document names to chart, in that order (default: all)
`;

function main(): void {
	const argv = process.argv.slice(2);
	const positional: string[] = [];
	let documentNames: string[] | undefined;
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case '--documents':
				if (i + 1 >= argv.length) {
					throw new Error(`--documents needs a value\n\n${HELP}`);
				}
				documentNames = argv[++i].split(',').map(s => s.trim()).filter(s => s.length > 0);
				break;
			case '--help': case '-h':
				process.stdout.write(HELP);
				process.exit(0);
			default:
				if (argv[i].startsWith('--')) {
					throw new Error(`Unknown option ${argv[i]}\n\n${HELP}`);
				}
				positional.push(argv[i]);
		}
	}
	if (positional.length < 1 || positional.length > 2) {
		throw new Error(HELP);
	}

	const [reportPath, outDir = path.dirname(reportPath)] = positional;
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as IBenchReport;
	for (const file of renderCharts(chartInput(report, documentNames), outDir)) {
		process.stderr.write(`wrote ${file}\n`);
	}
}

main();
