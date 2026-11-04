import assert from "node:assert/strict";
import { test } from "node:test";
import {
	estimateTextTokens,
	formatElapsed,
	formatRoundStatus,
	formatTokenCount,
	RoundTokenTracker,
	type TokenUsage,
} from "../src/token-tracker.ts";

const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test("estimateTextTokens counts CJK characters more heavily than Latin text", () => {
	assert.equal(estimateTextTokens(""), 0);
	assert.equal(estimateTextTokens("abcd"), 1);
	assert.equal(estimateTextTokens("你好世界"), 4);
	assert.equal(estimateTextTokens("こんにちは"), 5);
	assert.equal(estimateTextTokens("안녕"), 2);
	assert.equal(estimateTextTokens("ab你"), 1.5);
});

test("readSnapshot returns null before the first round", () => {
	assert.equal(new RoundTokenTracker().readSnapshot(0), null);
});

test("the snapshot grows live while a response streams", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(1000);
	tracker.beginResponse(500);
	tracker.addOutputText("abcdefgh");
	assert.deepEqual(tracker.readSnapshot(3000), {
		isActive: true,
		inputTokens: 500,
		cachedInputTokens: 0,
		outputTokens: 2,
		isInputEstimated: true,
		isOutputEstimated: true,
		elapsedMs: 2000,
	});
	tracker.addOutputText("abcdefgh");
	assert.equal(tracker.readSnapshot(3000)?.outputTokens, 4);
});

test("partial usage replaces the input estimate, and a low placeholder output does not hide the estimate", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(0);
	tracker.beginResponse(500);
	tracker.addOutputText("a".repeat(40));
	tracker.applyPartialUsage({ input: 100, output: 1, cacheRead: 300, cacheWrite: 50 });
	const snapshot = tracker.readSnapshot(0);
	assert.equal(snapshot?.inputTokens, 450);
	assert.equal(snapshot?.cachedInputTokens, 300);
	assert.equal(snapshot?.isInputEstimated, false);
	assert.equal(snapshot?.outputTokens, 10);
	assert.equal(snapshot?.isOutputEstimated, true);
});

test("exact usage replaces estimates when a response completes, and responses add up", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(0);
	tracker.beginResponse(999);
	tracker.addOutputText("a".repeat(400));
	tracker.completeResponse({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
	tracker.beginResponse(999);
	tracker.completeResponse({ input: 150, output: 30, cacheRead: 50, cacheWrite: 0 });
	const snapshot = tracker.readSnapshot(0);
	assert.equal(snapshot?.inputTokens, 300);
	assert.equal(snapshot?.cachedInputTokens, 50);
	assert.equal(snapshot?.outputTokens, 50);
	assert.equal(snapshot?.isInputEstimated, false);
	assert.equal(snapshot?.isOutputEstimated, false);
});

test("startRound resets the figures of the previous round", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(0);
	tracker.beginResponse(null);
	tracker.completeResponse({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
	tracker.finishRound(10);
	tracker.startRound(20);
	const snapshot = tracker.readSnapshot(20);
	assert.equal(snapshot?.inputTokens, 0);
	assert.equal(snapshot?.outputTokens, 0);
	assert.equal(snapshot?.isActive, true);
});

test("a request that failed before producing anything counts nothing", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(0);
	tracker.beginResponse(5000);
	tracker.completeResponse(NO_USAGE);
	const snapshot = tracker.readSnapshot(0);
	assert.equal(snapshot?.inputTokens, 0);
	assert.equal(snapshot?.isInputEstimated, false);
});

test("an aborted response without a usage report keeps its estimates", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(0);
	tracker.beginResponse(800);
	tracker.addOutputText("a".repeat(40));
	tracker.completeResponse(NO_USAGE);
	const snapshot = tracker.readSnapshot(0);
	assert.equal(snapshot?.inputTokens, 800);
	assert.equal(snapshot?.outputTokens, 10);
	assert.equal(snapshot?.isInputEstimated, true);
	assert.equal(snapshot?.isOutputEstimated, true);
});

test("an aborted response keeps usage that the stream already reported", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(0);
	tracker.beginResponse(800);
	tracker.applyPartialUsage({ input: 600, output: 0, cacheRead: 0, cacheWrite: 0 });
	tracker.addOutputText("a".repeat(40));
	tracker.completeResponse(NO_USAGE);
	const snapshot = tracker.readSnapshot(0);
	assert.equal(snapshot?.inputTokens, 600);
	assert.equal(snapshot?.isInputEstimated, false);
	assert.equal(snapshot?.outputTokens, 10);
	assert.equal(snapshot?.isOutputEstimated, true);
});

test("finishRound folds an open response, freezes the time, and is idempotent", () => {
	const tracker = new RoundTokenTracker();
	tracker.startRound(1000);
	tracker.beginResponse(100);
	tracker.addOutputText("a".repeat(8));
	tracker.finishRound(4000);
	tracker.finishRound(9000);
	const snapshot = tracker.readSnapshot(99_000);
	assert.equal(snapshot?.isActive, false);
	assert.equal(snapshot?.elapsedMs, 3000);
	assert.equal(snapshot?.inputTokens, 100);
	assert.equal(snapshot?.outputTokens, 2);
});

test("formatTokenCount chooses short units", () => {
	assert.equal(formatTokenCount(0), "0");
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1000), "1.0k");
	assert.equal(formatTokenCount(45_200), "45.2k");
	assert.equal(formatTokenCount(999_949), "999.9k");
	assert.equal(formatTokenCount(999_950), "1.00M");
	assert.equal(formatTokenCount(3_400_000), "3.40M");
});

test("formatElapsed shows seconds and minutes", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(12_900), "12s");
	assert.equal(formatElapsed(65_000), "1m 05s");
});

test("formatRoundStatus marks estimates and shows the cached part", () => {
	const base = {
		inputTokens: 45_200,
		cachedInputTokens: 0,
		outputTokens: 1300,
		elapsedMs: 12_000,
	};
	assert.equal(
		formatRoundStatus({ ...base, isActive: true, isInputEstimated: true, isOutputEstimated: true }),
		"This round: ↑ ~45.2k ↓ ~1.3k tokens · 12s",
	);
	assert.equal(
		formatRoundStatus({
			...base,
			cachedInputTokens: 40_000,
			isActive: false,
			isInputEstimated: false,
			isOutputEstimated: false,
		}),
		"Last round: ↑ 45.2k (40.0k cached) ↓ 1.3k tokens · 12s",
	);
});
