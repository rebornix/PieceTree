/**
 * Small deterministic PRNG (mulberry32) so that randomized tests and
 * benchmarks are reproducible from a seed.
 */
export class Prng {
	private _state: number;

	constructor(public readonly seed: number) {
		this._state = seed >>> 0;
	}

	/** Uniform float in [0, 1). */
	next(): number {
		this._state = (this._state + 0x6D2B79F5) >>> 0;
		let t = this._state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** Uniform integer in [0, bound). */
	nextInt(bound: number): number {
		return Math.floor(this.next() * bound);
	}

	/** Uniform integer in [min, max]. */
	nextIntBetween(min: number, max: number): number {
		return min + this.nextInt(max - min + 1);
	}

	nextString(alphabet: string, length: number): string {
		let out = '';
		for (let i = 0; i < length; i++) {
			out += alphabet[this.nextInt(alphabet.length)];
		}
		return out;
	}
}
