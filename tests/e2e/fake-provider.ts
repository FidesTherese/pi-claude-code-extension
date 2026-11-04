/**
 * A scripted model for the end-to-end test. It runs inside real Pi, makes no network calls,
 * and streams slowly so that the test can observe every status.
 */

import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STREAM_DELAY_MS = 120;
const TOOL_DELAY_MS = 1000;

/** Describes one model response: an optional tool call, an optional answer, and final usage. */
interface ScriptStep {
	tool?: { name: string; arguments: Record<string, string> };
	answer?: string;
	usage: { input: number; output: number; cacheRead: number };
}

const FIRST_ROUND_SCRIPT: ScriptStep[] = [
	{ tool: { name: "bash", arguments: { command: "echo hello" } }, usage: { input: 1000, output: 50, cacheRead: 200 } },
	{ tool: { name: "read", arguments: { path: "notes.txt" } }, usage: { input: 1100, output: 60, cacheRead: 300 } },
	{ answer: "The first round is done.", usage: { input: 1200, output: 70, cacheRead: 400 } },
];
const SECOND_ROUND_SCRIPT: ScriptStep[] = [{ answer: "The second round is done.", usage: { input: 500, output: 20, cacheRead: 0 } }];

/**
 * Wait for a number of milliseconds and return when the time has passed.
 *
 * :param delayMs: number; time to wait in milliseconds.
 * return None: Promise<void>; resolves after the delay.
 */
function waitFor(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Register the scripted model and slow down tools, so that short tool runs stay visible.
 *
 * The model chooses its response from the newest user text and from the number of tool
 * results after that text. Usage appears only in the final event, as with many providers.
 *
 * :param pi: ExtensionAPI; Pi's extension interface.
 * return None: None; no value is returned.
 */
export default function installFakeProvider(pi: ExtensionAPI): void {
	pi.on("tool_call", async () => {
		await waitFor(TOOL_DELAY_MS);
	});

	pi.registerProvider("fake", {
		baseUrl: "http://localhost.invalid",
		apiKey: "not-a-real-key",
		api: "fake-api",
		models: [
			{
				id: "scripted",
				name: "Scripted Test Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const messages = context.messages;
			let lastUserIndex = messages.length - 1;
			while (lastUserIndex > 0 && messages[lastUserIndex]?.role !== "user") {
				lastUserIndex -= 1;
			}
			const toolResultCount = messages.slice(lastUserIndex).filter((message) => message.role === "toolResult").length;
			const isSecondRound = JSON.stringify(messages[lastUserIndex]).includes("second");
			const script = isSecondRound ? SECOND_ROUND_SCRIPT : FIRST_ROUND_SCRIPT;
			const step = script[Math.min(toolResultCount, script.length - 1)]!;

			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};

			void (async () => {
				stream.push({ type: "start", partial: output });
				const thinking = { type: "thinking" as const, thinking: "" };
				output.content.push(thinking);
				stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
				for (let index = 0; index < 10; index += 1) {
					await waitFor(STREAM_DELAY_MS);
					if (options?.signal?.aborted) {
						output.stopReason = "aborted";
						stream.push({ type: "error", reason: "aborted", error: output });
						stream.end();
						return;
					}
					const delta = "reasoning words ".repeat(5);
					thinking.thinking += delta;
					stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: output });
				}
				stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: output });

				const contentIndex = 1;
				if (step.tool) {
					const toolCall = {
						type: "toolCall" as const,
						id: `call-${toolResultCount}`,
						name: step.tool.name,
						arguments: step.tool.arguments,
					};
					output.content.push(toolCall);
					output.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					await waitFor(STREAM_DELAY_MS * 3);
					stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(step.tool.arguments), partial: output });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				} else if (step.answer) {
					const text = { type: "text" as const, text: "" };
					output.content.push(text);
					stream.push({ type: "text_start", contentIndex, partial: output });
					for (const word of step.answer.split(" ")) {
						await waitFor(STREAM_DELAY_MS * 2);
						text.text += `${word} `;
						stream.push({ type: "text_delta", contentIndex, delta: `${word} `, partial: output });
					}
					stream.push({ type: "text_end", contentIndex, content: text.text, partial: output });
				}

				output.usage.input = step.usage.input;
				output.usage.output = step.usage.output;
				output.usage.cacheRead = step.usage.cacheRead;
				output.usage.totalTokens = step.usage.input + step.usage.output + step.usage.cacheRead;
				stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
				stream.end();
			})();

			return stream;
		},
	});
}
