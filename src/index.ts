/**
 * Entry point of the extension. Connects Pi's lifecycle events to the three state classes
 * and writes their results to the Pi interface. This is the only file that touches Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatBaseTitle, TitleBlinker } from "./title-blinker.ts";
import { formatRoundStatus, RoundTokenTracker } from "./token-tracker.ts";
import { WorkStatusTracker } from "./work-status.ts";

const STATUS_REFRESH_MS = 200;
const STATUS_KEY = "0-claude-code-tokens";
const WORKING_INDICATOR_FRAME = "🟢";

/**
 * Report whether the context belongs to Pi's interactive terminal and return the answer.
 *
 * In RPC mode, status and title calls would become output messages, so the extension
 * stays silent everywhere except the terminal interface.
 *
 * :param ctx: ExtensionContext; context of the current event.
 * return isTerminal: boolean; true only in interactive terminal mode.
 */
function isTerminalUi(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

/**
 * Run a display update and ignore any error that it throws.
 *
 * A context can become invalid when a session is replaced, and a display problem must
 * never disturb the agent.
 *
 * :param update: () => void; the display update to run.
 * return None: None; no value is returned.
 */
function safelyUpdateUi(update: () => void): void {
	try {
		update();
	} catch {
		// A status display has no recovery path and must not affect the agent.
	}
}

/**
 * Register the event handlers that give Pi its Claude Code style status display.
 *
 * Pi calls this factory once per extension runtime. The factory starts no timers, because
 * Pi also loads extensions when no session will start. Rounds start the timers instead,
 * and `agent_settled` or `session_shutdown` stops them.
 *
 * :param pi: ExtensionAPI; Pi's extension interface.
 * return None: None; no value is returned.
 */
export default function installClaudeCodeLook(pi: ExtensionAPI): void {
	const workStatus = new WorkStatusTracker();
	const roundTokens = new RoundTokenTracker();
	let latestCtx: ExtensionContext | null = null;
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let lastWorkLabel: string | undefined;
	let lastTokenStatus: string | undefined;

	const titleBlinker = new TitleBlinker(
		(title) => safelyUpdateUi(() => latestCtx?.ui.setTitle(title)),
		() => formatBaseTitle(latestCtx?.cwd ?? process.cwd(), pi.getSessionName()),
	);

	/**
	 * Write the current work label to the working row when it has changed.
	 *
	 * :param ctx: ExtensionContext; context of the current event.
	 * return None: None; no value is returned.
	 */
	function publishWorkLabel(ctx: ExtensionContext): void {
		const label = workStatus.readLabel();
		if (label !== lastWorkLabel) {
			lastWorkLabel = label;
			safelyUpdateUi(() => ctx.ui.setWorkingMessage(label));
		}
	}

	/**
	 * Write the current token figures to the bottom line when they have changed.
	 *
	 * :param ctx: ExtensionContext; context used to reach the interface and its theme.
	 * return None: None; no value is returned.
	 */
	function publishTokenStatus(ctx: ExtensionContext): void {
		const snapshot = roundTokens.readSnapshot(Date.now());
		if (!snapshot) {
			return;
		}
		const status = formatRoundStatus(snapshot);
		if (status !== lastTokenStatus) {
			lastTokenStatus = status;
			safelyUpdateUi(() => ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", status)));
		}
	}

	/**
	 * Stop the bottom-line timer when it is running.
	 *
	 * return None: None; no value is returned.
	 */
	function stopStatusTimer(): void {
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = null;
		}
	}

	/**
	 * Reset the trackers and start the title blinker and the bottom-line timer.
	 *
	 * :param ctx: ExtensionContext; context of the event that started the round.
	 * return None: None; no value is returned.
	 */
	function beginRound(ctx: ExtensionContext): void {
		roundTokens.startRound(Date.now());
		workStatus.reset();
		titleBlinker.start();
		publishTokenStatus(ctx);
		stopStatusTimer();
		statusTimer = setInterval(() => {
			if (latestCtx) {
				publishTokenStatus(latestCtx);
			}
		}, STATUS_REFRESH_MS);
		statusTimer.unref?.();
	}

	/**
	 * Finish the round, stop all timers, and write the final figures.
	 *
	 * The call has no effect when no round is running.
	 *
	 * :param ctx: ExtensionContext; context of the event that ended the round.
	 * return None: None; no value is returned.
	 */
	function endRound(ctx: ExtensionContext): void {
		if (!roundTokens.isRoundActive()) {
			return;
		}
		roundTokens.finishRound(Date.now());
		workStatus.reset();
		stopStatusTimer();
		titleBlinker.stop();
		lastWorkLabel = undefined;
		safelyUpdateUi(() => ctx.ui.setWorkingMessage());
		publishTokenStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		if (!isTerminalUi(ctx)) {
			return;
		}
		latestCtx = ctx;
		safelyUpdateUi(() => ctx.ui.setWorkingIndicator({ frames: [WORKING_INDICATOR_FRAME] }));
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!isTerminalUi(ctx)) {
			return;
		}
		latestCtx = ctx;
		if (!roundTokens.isRoundActive()) {
			beginRound(ctx);
		}
		publishWorkLabel(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!isTerminalUi(ctx)) {
			return;
		}
		workStatus.markThinking();
		publishWorkLabel(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (isTerminalUi(ctx) && event.message.role === "assistant") {
			roundTokens.beginResponse(ctx.getContextUsage()?.tokens ?? null);
		}
	});

	pi.on("message_update", (event, ctx) => {
		if (!isTerminalUi(ctx)) {
			return;
		}
		const update = event.assistantMessageEvent;
		switch (update.type) {
			case "thinking_start":
			case "thinking_delta":
				workStatus.markThinking();
				break;
			case "text_start":
			case "text_delta":
				workStatus.markWriting();
				break;
			case "toolcall_start":
			case "toolcall_delta":
				workStatus.markPreparingTool();
				break;
			default:
				break;
		}
		if (update.type === "thinking_delta" || update.type === "text_delta" || update.type === "toolcall_delta") {
			roundTokens.addOutputText(update.delta);
		}
		if ("partial" in update && update.partial.usage) {
			roundTokens.applyPartialUsage(update.partial.usage);
		}
		publishWorkLabel(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (isTerminalUi(ctx) && event.message.role === "assistant") {
			roundTokens.completeResponse(event.message.usage);
			workStatus.markThinking();
			publishWorkLabel(ctx);
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!isTerminalUi(ctx)) {
			return;
		}
		workStatus.startTool(event.toolCallId, event.toolName, event.args);
		publishWorkLabel(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!isTerminalUi(ctx)) {
			return;
		}
		workStatus.endTool(event.toolCallId);
		publishWorkLabel(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (isTerminalUi(ctx)) {
			endRound(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		stopStatusTimer();
		titleBlinker.stop();
		latestCtx = null;
	});
}
