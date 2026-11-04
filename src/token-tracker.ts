/**
 * Token accounting for one round, which is one prompt up to the moment Pi settles.
 * This file imports nothing from Pi, so its tests run without the host.
 */

/**
 * Describe the token fields that the tracker reads from Pi's `Usage` type.
 *
 * All fields are required, non-negative token counts.
 *
 * :param input: number; uncached input tokens of one model request.
 * :param output: number; output tokens of one model request, including reasoning.
 * :param cacheRead: number; input tokens served from the provider cache.
 * :param cacheWrite: number; input tokens written to the provider cache.
 * return usage: TokenUsage; usage figures of one model request.
 */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Describe the display figures of one round at one moment.
 *
 * The token counts are whole numbers. An estimated flag is true when any part of its
 * count comes from an estimate rather than from a provider report.
 *
 * :param isActive: boolean; true until the round settles.
 * :param inputTokens: number; sum of input, cacheRead, and cacheWrite across requests.
 * :param cachedInputTokens: number; sum of cacheRead across requests.
 * :param outputTokens: number; sum of output across requests.
 * :param isInputEstimated: boolean; true when inputTokens contains an estimate.
 * :param isOutputEstimated: boolean; true when outputTokens contains an estimate.
 * :param elapsedMs: number; milliseconds since the round started, frozen at its end.
 * return snapshot: RoundSnapshot; immutable copy of the round figures.
 */
export interface RoundSnapshot {
	isActive: boolean;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	isInputEstimated: boolean;
	isOutputEstimated: boolean;
	elapsedMs: number;
}

/** Holds the running figures of the response that is currently streaming. */
interface OpenResponse {
	estimatedInputTokens: number | null;
	estimatedOutputTokens: number;
	reportedUsage: TokenUsage | null;
}

const WIDE_SCRIPT_PATTERN =
	/[⺀-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯\u{20000}-\u{3FFFF}]/u;

/**
 * Estimate the token count of streamed text and return a possibly fractional number.
 *
 * Each Chinese, Japanese, or Korean code point counts as one token, and each other code
 * point counts as a quarter of a token. Providers replace this estimate with exact
 * numbers when they report usage.
 *
 * :param text: string; streamed text fragment, which may be empty.
 * return tokenEstimate: number; estimated tokens of the fragment.
 */
export function estimateTextTokens(text: string): number {
	let estimate = 0;
	for (const character of text) {
		estimate += WIDE_SCRIPT_PATTERN.test(character) ? 1 : 0.25;
	}
	return estimate;
}

/**
 * Sum the input token fields of a usage report and return the total.
 *
 * The total includes cached input, because cached tokens are still part of the request.
 *
 * :param usage: TokenUsage; usage report of one model request.
 * return inputTotal: number; input plus cacheRead plus cacheWrite.
 */
function sumInputTokens(usage: TokenUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * Track the exact and estimated tokens of one round and return snapshots for display.
 *
 * A round can hold many responses. At most one response is open at a time. A reported
 * figure above zero counts as exact. Otherwise the tracker uses its estimate and raises
 * the matching estimated flag. Methods never throw.
 *
 * return instance: RoundTokenTracker; tracker with no round started.
 */
export class RoundTokenTracker {
	private hasStarted = false;
	private isActive = false;
	private startedAtMs = 0;
	private finishedAtMs = 0;
	private inputTotal = 0;
	private cachedInputTotal = 0;
	private outputTotal = 0;
	private hasEstimatedInput = false;
	private hasEstimatedOutput = false;
	private openResponse: OpenResponse | null = null;

	/**
	 * Start a new round at a given time and clear every previous figure.
	 *
	 * :param nowMs: number; current time in milliseconds.
	 * return None: None; no value is returned.
	 */
	startRound(nowMs: number): void {
		this.hasStarted = true;
		this.isActive = true;
		this.startedAtMs = nowMs;
		this.finishedAtMs = 0;
		this.inputTotal = 0;
		this.cachedInputTotal = 0;
		this.outputTotal = 0;
		this.hasEstimatedInput = false;
		this.hasEstimatedOutput = false;
		this.openResponse = null;
	}

	/**
	 * Report whether a round is running and return the answer.
	 *
	 * return isActive: boolean; true between startRound and finishRound.
	 */
	isRoundActive(): boolean {
		return this.isActive;
	}

	/**
	 * Open a response with an input estimate and discard any earlier open response.
	 *
	 * An earlier open response only exists when Pi skipped its end event, and that
	 * response has no trustworthy figures to keep.
	 *
	 * :param estimatedInputTokens: number | null; context size estimate, or null when unknown.
	 * return None: None; no value is returned.
	 */
	beginResponse(estimatedInputTokens: number | null): void {
		this.openResponse = { estimatedInputTokens, estimatedOutputTokens: 0, reportedUsage: null };
	}

	/**
	 * Add streamed output text to the estimate of the open response.
	 *
	 * The call has no effect when no response is open.
	 *
	 * :param text: string; streamed text, reasoning, or tool-call fragment.
	 * return None: None; no value is returned.
	 */
	addOutputText(text: string): void {
		if (this.openResponse) {
			this.openResponse.estimatedOutputTokens += estimateTextTokens(text);
		}
	}

	/**
	 * Store the newest usage that the provider reported during a stream.
	 *
	 * The call has no effect when no response is open.
	 *
	 * :param usage: TokenUsage; latest cumulative usage of the open response.
	 * return None: None; no value is returned.
	 */
	applyPartialUsage(usage: TokenUsage): void {
		if (this.openResponse) {
			this.openResponse.reportedUsage = usage;
		}
	}

	/**
	 * Move the open response into the round totals by using its final usage report.
	 *
	 * A final report of all zeros falls back to the newest report from the stream, which
	 * matters for an aborted response. A response with no reported usage and no estimated
	 * output is discarded, because the request failed before the model produced anything.
	 *
	 * :param finalUsage: TokenUsage; final usage of the response, with zeros when not reported.
	 * return None: None; no value is returned.
	 */
	completeResponse(finalUsage: TokenUsage): void {
		const response = this.openResponse;
		this.openResponse = null;
		const hasFinalReport = sumInputTokens(finalUsage) > 0 || finalUsage.output > 0;
		const usage = hasFinalReport ? finalUsage : (response?.reportedUsage ?? finalUsage);
		const estimatedOutput = response?.estimatedOutputTokens ?? 0;
		const reportedInput = sumInputTokens(usage);
		if (reportedInput === 0 && usage.output === 0 && estimatedOutput === 0) {
			return;
		}

		if (reportedInput > 0) {
			this.inputTotal += reportedInput;
			this.cachedInputTotal += usage.cacheRead;
		} else if (response?.estimatedInputTokens) {
			this.inputTotal += response.estimatedInputTokens;
			this.hasEstimatedInput = true;
		}

		if (usage.output > 0) {
			this.outputTotal += usage.output;
		} else {
			this.outputTotal += estimatedOutput;
			this.hasEstimatedOutput = estimatedOutput > 0 || this.hasEstimatedOutput;
		}
	}

	/**
	 * Finish the round at a given time and keep its figures for later display.
	 *
	 * A response that is still open keeps its estimates. A second call has no effect.
	 *
	 * :param nowMs: number; current time in milliseconds.
	 * return None: None; no value is returned.
	 */
	finishRound(nowMs: number): void {
		if (!this.isActive) {
			return;
		}
		this.completeResponse({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		this.isActive = false;
		this.finishedAtMs = nowMs;
	}

	/**
	 * Combine the totals with the open response and return a display snapshot.
	 *
	 * While a response is open, its output figure is the larger of the reported value and
	 * the estimate, because some providers report a tiny placeholder at stream start.
	 *
	 * :param nowMs: number; current time in milliseconds.
	 * return snapshot: RoundSnapshot | null; current figures, or null before the first round.
	 */
	readSnapshot(nowMs: number): RoundSnapshot | null {
		if (!this.hasStarted) {
			return null;
		}

		let inputTokens = this.inputTotal;
		let cachedInputTokens = this.cachedInputTotal;
		let outputTokens = this.outputTotal;
		let isInputEstimated = this.hasEstimatedInput;
		let isOutputEstimated = this.hasEstimatedOutput;

		const response = this.openResponse;
		if (response) {
			const reported = response.reportedUsage;
			const reportedInput = reported ? sumInputTokens(reported) : 0;
			if (reported && reportedInput > 0) {
				inputTokens += reportedInput;
				cachedInputTokens += reported.cacheRead;
			} else if (response.estimatedInputTokens) {
				inputTokens += response.estimatedInputTokens;
				isInputEstimated = true;
			}

			const reportedOutput = reported?.output ?? 0;
			if (reportedOutput >= response.estimatedOutputTokens) {
				outputTokens += reportedOutput;
			} else {
				outputTokens += response.estimatedOutputTokens;
				isOutputEstimated = true;
			}
		}

		return {
			isActive: this.isActive,
			inputTokens: Math.round(inputTokens),
			cachedInputTokens: Math.round(cachedInputTokens),
			outputTokens: Math.round(outputTokens),
			isInputEstimated,
			isOutputEstimated,
			elapsedMs: (this.isActive ? nowMs : this.finishedAtMs) - this.startedAtMs,
		};
	}
}

/**
 * Format a token count in a short form and return the text.
 *
 * Counts below 1,000 stay whole, counts below one million use `k`, and larger counts use `M`.
 *
 * :param count: number; non-negative token count.
 * return text: string; for example "950", "1.2k", or "3.40M".
 */
export function formatTokenCount(count: number): string {
	if (count < 1000) {
		return String(count);
	}
	if (count < 999_950) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	return `${(count / 1_000_000).toFixed(2)}M`;
}

/**
 * Format a duration in seconds and minutes and return the text.
 *
 * :param elapsedMs: number; non-negative duration in milliseconds.
 * return text: string; for example "12s" or "1m 05s".
 */
export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.floor(elapsedMs / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return `${Math.floor(totalSeconds / 60)}m ${seconds}s`;
}

/**
 * Build the bottom status line from a round snapshot and return the text.
 *
 * A `~` marks each estimated figure, and the cached part appears only when it is above zero.
 *
 * :param snapshot: RoundSnapshot; figures to display.
 * return statusLine: string; for example "This round: ↑ ~45.2k ↓ ~1.3k tokens · 12s".
 */
export function formatRoundStatus(snapshot: RoundSnapshot): string {
	const label = snapshot.isActive ? "This round:" : "Last round:";
	const inputMark = snapshot.isInputEstimated ? "~" : "";
	const outputMark = snapshot.isOutputEstimated ? "~" : "";
	const cachedPart =
		snapshot.cachedInputTokens > 0 ? ` (${formatTokenCount(snapshot.cachedInputTokens)} cached)` : "";
	const input = `↑ ${inputMark}${formatTokenCount(snapshot.inputTokens)}${cachedPart}`;
	const output = `↓ ${outputMark}${formatTokenCount(snapshot.outputTokens)}`;
	return `${label} ${input} ${output} tokens · ${formatElapsed(snapshot.elapsedMs)}`;
}
