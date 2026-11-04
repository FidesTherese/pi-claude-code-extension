import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BLINK_INTERVAL_MS, formatBaseTitle, TitleBlinker } from "../src/title-blinker.ts";

test("formatBaseTitle matches Pi's normal title", () => {
	const cwd = join("work", "my-project");
	assert.equal(formatBaseTitle(cwd, undefined), "π - my-project");
	assert.equal(formatBaseTitle(cwd, "fix bug"), "π - fix bug - my-project");
});

test("the blinker alternates circles and restores the title", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const titles: string[] = [];
	const blinker = new TitleBlinker(
		(title) => titles.push(title),
		() => "π - x",
	);

	blinker.start();
	assert.deepEqual(titles, ["🟢 π - x"]);
	t.mock.timers.tick(BLINK_INTERVAL_MS);
	t.mock.timers.tick(BLINK_INTERVAL_MS);
	t.mock.timers.tick(BLINK_INTERVAL_MS);
	assert.deepEqual(titles, ["🟢 π - x", "🔴 π - x", "🟢 π - x", "🔴 π - x"]);

	blinker.stop();
	assert.equal(titles.at(-1), "π - x");
	const countAfterStop = titles.length;
	t.mock.timers.tick(BLINK_INTERVAL_MS * 4);
	assert.equal(titles.length, countAfterStop);
});

test("start and stop are idempotent, and a restart begins with green", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const titles: string[] = [];
	const blinker = new TitleBlinker(
		(title) => titles.push(title),
		() => "base",
	);

	blinker.stop();
	assert.deepEqual(titles, []);
	blinker.start();
	blinker.start();
	assert.deepEqual(titles, ["🟢 base"]);
	t.mock.timers.tick(BLINK_INTERVAL_MS);
	assert.equal(titles.length, 2);
	blinker.stop();
	blinker.stop();
	assert.equal(titles.at(-1), "base");
	assert.equal(titles.length, 3);
	blinker.start();
	assert.equal(titles.at(-1), "🟢 base");
	blinker.stop();
});

test("a session rename appears at the next tick", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let base = "old";
	const titles: string[] = [];
	const blinker = new TitleBlinker(
		(title) => titles.push(title),
		() => base,
	);
	blinker.start();
	base = "new";
	t.mock.timers.tick(BLINK_INTERVAL_MS);
	assert.equal(titles.at(-1), "🔴 new");
	blinker.stop();
});
