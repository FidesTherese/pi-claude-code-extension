import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import installClaudeCodeLook from "../src/index.ts";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Holds a fake Pi and context, plus every interface call that the extension makes. */
function createHarness(mode = "tui") {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const calls = { messages: [] as (string | undefined)[], statuses: [] as (string | undefined)[], titles: [] as string[], indicators: [] as unknown[] };
	const ctx = {
		mode,
		cwd: "project",
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		ui: {
			setWorkingMessage: (message?: string) => calls.messages.push(message),
			setWorkingIndicator: (options: unknown) => calls.indicators.push(options),
			setStatus: (_key: string, text: string | undefined) => calls.statuses.push(text),
			setTitle: (title: string) => calls.titles.push(title),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
		getSessionName: () => undefined,
	};
	installClaudeCodeLook(pi as never);
	const emit = (name: string, event: object = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
	return { emit, calls, ctx };
}

/** Enables mocked timers and fixes the clock so that the test controls all time. */
function enableMockTime(t: TestContext): void {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
}

test("a full round updates the row, the token line, and the title", (t) => {
	enableMockTime(t);
	const { emit, calls } = createHarness();

	emit("session_start");
	assert.deepEqual(calls.indicators, [{ frames: ["🟢"] }]);

	emit("agent_start");
	assert.equal(calls.titles.at(-1), "🟢 π - project");
	assert.equal(calls.messages.at(-1), "Thinking…");

	emit("turn_start");
	emit("message_start", { message: { role: "assistant" } });
	emit("message_update", {
		assistantMessageEvent: { type: "text_delta", delta: "a".repeat(400), partial: { usage: ZERO_USAGE } },
	});
	assert.equal(calls.messages.at(-1), "Writing response…");
	t.mock.timers.tick(200);
	assert.equal(calls.statuses.at(-1), "This round: ↑ ~1.0k ↓ ~100 tokens · 0s");

	emit("message_end", { message: { role: "assistant", usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0 } } });
	emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "git status" } });
	assert.equal(calls.messages.at(-1), "Running git status");
	emit("tool_execution_end", { toolCallId: "1" });
	assert.equal(calls.messages.at(-1), "Thinking…");

	t.mock.timers.tick(500);
	assert.ok(calls.titles.includes("🔴 π - project"));

	emit("agent_settled", { aborted: false });
	assert.equal(calls.titles.at(-1), "π - project");
	assert.equal(calls.messages.at(-1), undefined);
	assert.equal(calls.statuses.at(-1), "Last round: ↑ 900 ↓ 120 tokens · 0s");

	const titleCount = calls.titles.length;
	const statusCount = calls.statuses.length;
	t.mock.timers.tick(5000);
	assert.equal(calls.titles.length, titleCount);
	assert.equal(calls.statuses.length, statusCount);
});

test("a retry inside a round keeps the count, and the next prompt resets it", (t) => {
	enableMockTime(t);
	const { emit, calls } = createHarness();

	emit("agent_start");
	emit("message_start", { message: { role: "assistant" } });
	emit("message_end", { message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } });
	emit("agent_end");
	emit("agent_start");
	emit("message_start", { message: { role: "assistant" } });
	emit("message_end", { message: { role: "assistant", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 } } });
	emit("agent_settled", { aborted: false });
	assert.equal(calls.statuses.at(-1), "Last round: ↑ 300 ↓ 30 tokens · 0s");

	emit("agent_start");
	assert.equal(calls.statuses.at(-1), "This round: ↑ 0 ↓ 0 tokens · 0s");
	emit("agent_settled", { aborted: false });
});

test("user and tool-result messages do not open a response", (t) => {
	enableMockTime(t);
	const { emit, calls } = createHarness();
	emit("agent_start");
	emit("message_start", { message: { role: "user" } });
	emit("message_end", { message: { role: "user" } });
	emit("message_end", { message: { role: "toolResult" } });
	emit("agent_settled", { aborted: false });
	assert.equal(calls.statuses.at(-1), "Last round: ↑ 0 ↓ 0 tokens · 0s");
});

for (const mode of ["print", "json", "rpc"]) {
	test(`the extension stays silent in ${mode} mode`, (t) => {
		enableMockTime(t);
		const { emit, calls } = createHarness(mode);
		emit("session_start");
		emit("agent_start");
		emit("turn_start");
		emit("message_start", { message: { role: "assistant" } });
		emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x", partial: {} } });
		emit("message_end", { message: { role: "assistant", usage: ZERO_USAGE } });
		emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: {} });
		emit("tool_execution_end", { toolCallId: "1" });
		t.mock.timers.tick(2000);
		emit("agent_settled", { aborted: false });
		assert.deepEqual(calls, { messages: [], statuses: [], titles: [], indicators: [] });
	});
}

test("an interface error does not escape to Pi", (t) => {
	enableMockTime(t);
	const { emit, ctx } = createHarness();
	const fail = () => {
		throw new Error("stale context");
	};
	ctx.ui.setWorkingMessage = fail as never;
	ctx.ui.setStatus = fail as never;
	ctx.ui.setTitle = fail as never;
	ctx.ui.setWorkingIndicator = fail as never;

	assert.doesNotThrow(() => {
		emit("session_start");
		emit("agent_start");
		t.mock.timers.tick(1000);
		emit("agent_settled", { aborted: false });
	});
});

test("session shutdown stops the timers during a running round", (t) => {
	enableMockTime(t);
	const { emit, calls } = createHarness();
	emit("agent_start");
	emit("session_shutdown");
	const titleCount = calls.titles.length;
	t.mock.timers.tick(5000);
	assert.equal(calls.titles.length, titleCount);
});
