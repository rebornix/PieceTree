/** Wall-clock milliseconds of one call. */
export function timeMs(fn: () => void): number {
	const start = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - start) / 1e6;
}

export interface IStats {
	median: number;
	min: number;
	max: number;
	mean: number;
}

export function stats(samples: number[]): IStats {
	const sorted = samples.slice().sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	let sum = 0;
	for (const s of sorted) {
		sum += s;
	}
	return { median, min: sorted[0], max: sorted[sorted.length - 1], mean: sum / sorted.length };
}

declare const gc: (() => void) | undefined;

export function canMeasureMemory(): boolean {
	return typeof gc === 'function';
}

/**
 * Heap bytes retained by the object `build` returns (and everything it keeps
 * alive), measured as the difference in heap usage after full GCs before and
 * after. Anything `build` allocates and drops (for instance the chunk strings a
 * line array splits and forgets) is not counted. Needs --expose-gc; NaN without.
 */
export function measureRetainedHeap(build: () => object): number {
	if (typeof gc !== 'function') {
		return NaN;
	}
	gc();
	gc();
	const before = process.memoryUsage().heapUsed;
	const retained = build();
	gc();
	gc();
	const after = process.memoryUsage().heapUsed;
	if (retained === null) {
		// never true; keeps `retained` reachable until after the measurement
		throw new Error('unreachable');
	}
	return after - before;
}
