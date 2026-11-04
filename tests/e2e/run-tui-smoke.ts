/**
 * End-to-end test. Runs real Pi in a pseudo-terminal with the extension and a scripted model,
 * rebuilds the screen from the output bytes, and checks each acceptance criterion.
 * A temporary configuration directory keeps the test away from real credentials and models.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "@lydell/node-pty";
import xterm from "@xterm/headless";

const TERMINAL_COLUMNS = 110;
const TERMINAL_ROWS = 32;
const SAMPLE_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 45_000;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCliPath = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

const tempRoot = mkdtempSync(join(tmpdir(), "pi-claude-look-"));
const agentDir = join(tempRoot, "agent");
const workDir = join(tempRoot, "demo-project");
mkdirSync(agentDir);
mkdirSync(workDir);
writeFileSync(join(workDir, "notes.txt"), "Some notes for the test.\n");

const terminal = new xterm.Terminal({ cols: TERMINAL_COLUMNS, rows: TERMINAL_ROWS, allowProposedApi: true });
const titles: string[] = [];
const seenRows = new Set<string>();
const bottomLines: string[] = [];
terminal.onTitleChange((title) => titles.push(title));

const piProcess = spawn(
	process.execPath,
	[
		piCliPath,
		"--no-session",
		"-e",
		join(projectRoot, "src", "index.ts"),
		"-e",
		join(projectRoot, "tests", "e2e", "fake-provider.ts"),
		"--model",
		"fake/scripted",
	],
	{
		name: "xterm-256color",
		cols: TERMINAL_COLUMNS,
		rows: TERMINAL_ROWS,
		cwd: workDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
	},
);
piProcess.onData((data) => terminal.write(data));

/**
 * Read the visible terminal screen and return its rows without trailing spaces.
 *
 * return rows: string[]; visible rows from top to bottom, which may be empty strings.
 */
function readScreenRows(): string[] {
	const buffer = terminal.buffer.active;
	const rows: string[] = [];
	for (let index = 0; index < terminal.rows; index += 1) {
		rows.push(buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "");
	}
	return rows;
}

/**
 * Read the last row of the screen that has text and return it.
 *
 * return row: string; bottom text row, or an empty string for an empty screen.
 */
function readBottomRow(): string {
	return readScreenRows().filter((row) => row.trim() !== "").at(-1) ?? "";
}

/**
 * Wait for a number of milliseconds and return when the time has passed.
 *
 * :param delayMs: number; time to wait in milliseconds.
 * return None: Promise<void>; resolves after the delay.
 */
function waitFor(delayMs: number): Promise<void> {
	return new Promise((done) => setTimeout(done, delayMs));
}

/**
 * Sample the screen until a condition holds and record what appeared along the way.
 *
 * The function throws when the condition stays false for WAIT_TIMEOUT_MS, and the error
 * message contains the screen for diagnosis.
 *
 * :param description: string; condition description for the error message.
 * :param isDone: () => boolean; returns true when waiting can stop.
 * return None: Promise<void>; resolves when the condition holds.
 */
async function waitUntil(description: string, isDone: () => boolean): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		for (const row of readScreenRows()) {
			seenRows.add(row.trim());
		}
		const bottom = readBottomRow();
		if (bottomLines.at(-1) !== bottom) {
			bottomLines.push(bottom);
		}
		if (isDone()) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${description}. Screen:\n${readScreenRows().join("\n")}`);
		}
		await waitFor(SAMPLE_INTERVAL_MS);
	}
}

/**
 * Check whether a row with the given text has appeared and return the answer.
 *
 * :param text: string; text to look for.
 * return wasSeen: boolean; true when any sampled row contains the text.
 */
function wasRowSeen(text: string): boolean {
	return Array.from(seenRows).some((row) => row.includes(text));
}

const results: { name: string; passed: boolean; detail?: string }[] = [];

/**
 * Run one named check and record whether it passed.
 *
 * :param name: string; name of the check for the report.
 * :param check: () => void; assertion code, which throws on failure.
 * return None: None; no value is returned.
 */
function recordCheck(name: string, check: () => void): void {
	try {
		check();
		results.push({ name, passed: true });
	} catch (error) {
		results.push({ name, passed: false, detail: (error as Error).message });
	}
}

let exitCode = 1;
try {
	const folder = basename(workDir);
	await waitUntil("the editor", () => readScreenRows().join("\n").includes("scripted"));
	await waitFor(1500);

	piProcess.write("first prompt\r");
	await waitUntil("the end of round one", () => readBottomRow().includes("Last round:"));
	await waitFor(400);
	const titlesAfterFirstRound = [...titles];
	const firstRoundBottom = readBottomRow();
	const firstRoundScreen = readScreenRows().join("\n");
	const liveLinesFirstRound = bottomLines.filter((line) => line.includes("This round:"));

	piProcess.write("second prompt\r");
	await waitUntil("the start of round two", () => readBottomRow().includes("This round:"));
	await waitUntil("the end of round two", () => readBottomRow().includes("Last round:"));
	await waitFor(400);
	const secondRoundBottom = readBottomRow();

	piProcess.write("third prompt\r");
	await waitUntil("the start of round three", () => readBottomRow().includes("This round:"));
	await waitUntil("streamed output in round three", () => /↓ ~[1-9]/.test(readBottomRow()));
	piProcess.write("\x1b");
	await waitUntil("the end of the aborted round", () => readBottomRow().includes("Last round:"));
	await waitFor(400);
	const abortedRoundBottom = readBottomRow();
	const titleCountAfterAbort = titles.length;
	await waitFor(1500);
	const titlesAddedAfterAbort = titles.length - titleCountAfterAbort;

	recordCheck("Row shows 🟢 Thinking…", () => assert.ok(wasRowSeen("🟢 Thinking…")));
	recordCheck("Row shows 🟢 Running echo hello", () => assert.ok(wasRowSeen("🟢 Running echo hello")));
	recordCheck("Row shows 🟢 Reading notes.txt", () => assert.ok(wasRowSeen("🟢 Reading notes.txt")));
	recordCheck("Row shows 🟢 Writing response…", () => assert.ok(wasRowSeen("🟢 Writing response…")));
	recordCheck("Row shows 🟢 Preparing tool call…", () => assert.ok(wasRowSeen("🟢 Preparing tool call…")));
	recordCheck("Default working text never appears", () => assert.ok(!wasRowSeen("Working")));
	recordCheck("Token count grows live on the bottom row", () => {
		const outputs = liveLinesFirstRound.map((line) => line.match(/↓ ~?([\d.]+)/)?.[1]);
		assert.ok(new Set(outputs).size >= 3, `only saw: ${liveLinesFirstRound.join(" | ")}`);
		assert.ok(
			liveLinesFirstRound.some((line) => line.includes("~")),
			"no estimate mark during the stream",
		);
	});
	recordCheck("Round one ends with exact totals on the bottom row", () => {
		assert.match(firstRoundBottom, /Last round: ↑ 4\.2k \(900 cached\) ↓ 180 tokens · \d+s/);
	});
	recordCheck("Round two resets the count", () => {
		assert.match(secondRoundBottom, /Last round: ↑ 500 ↓ 20 tokens · \d+s/);
	});
	recordCheck("Escape ends the round and keeps the estimate mark", () => {
		assert.match(abortedRoundBottom, /Last round: .*↓ ~\d/);
	});
	recordCheck("Escape stops the blinking and restores the title", () => {
		assert.equal(titlesAddedAfterAbort, 0);
		assert.equal(titles.at(-1), `π - ${folder}`);
	});
	recordCheck("Title alternates green and red during work", () => {
		const blinkTitles = titlesAfterFirstRound.filter((title) => title.startsWith("🟢") || title.startsWith("🔴"));
		assert.ok(blinkTitles.length >= 6, `only ${blinkTitles.length} blink titles`);
		assert.equal(blinkTitles[0], `🟢 π - ${folder}`);
		blinkTitles.forEach((title, index) => {
			if (index > 0) {
				assert.notEqual(title.slice(0, 2), blinkTitles[index - 1]!.slice(0, 2), `no alternation at ${index}`);
			}
		});
		assert.ok(blinkTitles.includes(`🔴 π - ${folder}`));
	});
	recordCheck("Title returns to normal after work", () => {
		assert.equal(titlesAfterFirstRound.at(-1), `π - ${folder}`);
		assert.equal(titles.at(-1), `π - ${folder}`);
	});

	console.log("--- Screen after round one ---");
	console.log(firstRoundScreen.replace(/\n+$/, ""));
	console.log("--- Live bottom rows, sampled ---");
	console.log(liveLinesFirstRound.slice(0, 12).join("\n"));
	console.log("--- Result ---");
	for (const result of results) {
		console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `\n      ${result.detail}` : ""}`);
	}
	exitCode = results.every((result) => result.passed) ? 0 : 1;
} catch (error) {
	console.error(error);
} finally {
	piProcess.kill();
	terminal.dispose();
	await waitFor(500);
	try {
		rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		console.warn(`Could not remove the temporary directory: ${tempRoot}`);
	}
}
process.exit(exitCode);
