import assert from "node:assert/strict";
import { test } from "node:test";
import { describeToolWork, MAX_DETAIL_LENGTH, sanitizeDetail, WorkStatusTracker } from "../src/work-status.ts";

test("describeToolWork names the work of each built-in tool", () => {
	assert.equal(describeToolWork("bash", { command: "git status" }), "Running git status");
	assert.equal(describeToolWork("read", { path: "a.ts" }), "Reading a.ts");
	assert.equal(describeToolWork("edit", { path: "a.ts" }), "Editing a.ts");
	assert.equal(describeToolWork("write", { path: "a.ts" }), "Writing a.ts");
	assert.equal(describeToolWork("grep", { pattern: "TODO" }), "Searching for TODO");
	assert.equal(describeToolWork("find", { pattern: "*.ts" }), "Finding *.ts");
	assert.equal(describeToolWork("ls", { path: "src" }), "Listing src");
	assert.equal(describeToolWork("mcp__docs__search", { query: "private" }), "Using mcp__docs__search");
});

test("describeToolWork falls back when arguments are missing or malformed", () => {
	assert.equal(describeToolWork("bash", {}), "Running a command");
	assert.equal(describeToolWork("bash", null), "Running a command");
	assert.equal(describeToolWork("read", undefined), "Reading a file");
	assert.equal(describeToolWork("write", { path: 7 }), "Writing a file");
	assert.equal(describeToolWork("ls", { path: "  " }), "Listing files");
	assert.equal(describeToolWork("constructor", {}), "Using constructor");
});

test("sanitizeDetail removes escape sequences, control characters, and line breaks", () => {
	assert.equal(sanitizeDetail("\x1b[31mred\x1b[0m", 50), "red");
	assert.equal(sanitizeDetail("\x1b]0;evil title\x07safe", 50), "safe");
	assert.equal(sanitizeDetail("line1\nline2\r\n\tline3", 50), "line1 line2 line3");
	assert.equal(sanitizeDetail("a\x07b\x9bc", 50), "a b c");
});

test("sanitizeDetail shortens by code points without splitting emoji", () => {
	assert.equal(sanitizeDetail("abcdef", 6), "abcdef");
	assert.equal(sanitizeDetail("abcdefg", 6), "abcde…");
	assert.equal(sanitizeDetail("🟢🟢🟢🟢", 3), "🟢🟢…");
});

test("the tracker follows the model phases", () => {
	const tracker = new WorkStatusTracker();
	assert.equal(tracker.readLabel(), "Thinking…");
	tracker.markWriting();
	assert.equal(tracker.readLabel(), "Writing response…");
	tracker.markPreparingTool();
	assert.equal(tracker.readLabel(), "Preparing tool call…");
	tracker.markThinking();
	assert.equal(tracker.readLabel(), "Thinking…");
});

test("a running tool takes priority over the phase and returns to it afterwards", () => {
	const tracker = new WorkStatusTracker();
	tracker.startTool("1", "bash", { command: "npm test" });
	tracker.markWriting();
	assert.equal(tracker.readLabel(), "Running npm test");
	tracker.endTool("1");
	assert.equal(tracker.readLabel(), "Writing response…");
	tracker.endTool("unknown");
});

test("parallel tools show the newest one and how many others run", () => {
	const tracker = new WorkStatusTracker();
	tracker.startTool("1", "read", { path: "a.ts" });
	tracker.startTool("2", "read", { path: "b.ts" });
	tracker.startTool("3", "read", { path: "c.ts" });
	assert.equal(tracker.readLabel(), "Reading c.ts (+2 more)");
	tracker.endTool("3");
	assert.equal(tracker.readLabel(), "Reading b.ts (+1 more)");
	tracker.reset();
	assert.equal(tracker.readLabel(), "Thinking…");
});

test("a long label stays within the limit and keeps its suffix", () => {
	const tracker = new WorkStatusTracker();
	tracker.startTool("1", "read", { path: "a.ts" });
	tracker.startTool("2", "bash", { command: `echo ${"x".repeat(200)}\nrm -rf` });
	const label = tracker.readLabel();
	assert.ok(Array.from(label).length <= MAX_DETAIL_LENGTH);
	assert.ok(label.endsWith("… (+1 more)"));
	assert.ok(!label.includes("\n"));
});
