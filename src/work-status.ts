/**
 * Decides the text of the working row from the model phase and the running tools.
 * This file imports nothing from Pi, so its tests run without the host.
 */

export const MAX_DETAIL_LENGTH = 72;

const THINKING_LABEL = "Thinking…";
const WRITING_LABEL = "Writing response…";
const PREPARING_TOOL_LABEL = "Preparing tool call…";

const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\^_])/g;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]/g;

/** Holds the label parts of one built-in tool: its argument name, verb, and fallback text. */
interface ToolLabelRule {
	argumentName: string;
	verb: string;
	fallback: string;
}

const TOOL_LABEL_RULES: Readonly<Record<string, ToolLabelRule>> = {
	bash: { argumentName: "command", verb: "Running", fallback: "Running a command" },
	read: { argumentName: "path", verb: "Reading", fallback: "Reading a file" },
	edit: { argumentName: "path", verb: "Editing", fallback: "Editing a file" },
	write: { argumentName: "path", verb: "Writing", fallback: "Writing a file" },
	grep: { argumentName: "pattern", verb: "Searching for", fallback: "Searching files" },
	find: { argumentName: "pattern", verb: "Finding", fallback: "Finding files" },
	ls: { argumentName: "path", verb: "Listing", fallback: "Listing files" },
};

/**
 * Clean display text for one terminal row and return the shortened result.
 *
 * The function removes ANSI escape sequences, replaces control characters with spaces,
 * collapses whitespace, and shortens the text with a final ellipsis. It protects the
 * terminal from control codes inside commands and file names.
 *
 * :param text: string; untrusted text, such as a command from the model.
 * :param maxLength: number; longest allowed result in code points, at least 1.
 * return cleanText: string; single-line text of at most maxLength code points.
 */
export function sanitizeDetail(text: string, maxLength: number): string {
	const singleLine = text
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(CONTROL_CHARACTER_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim();
	const codePoints = Array.from(singleLine);
	if (codePoints.length <= maxLength) {
		return singleLine;
	}
	return `${codePoints.slice(0, maxLength - 1).join("")}…`;
}

/**
 * Describe a tool call in plain words and return the label.
 *
 * Built-in tools use their main argument. A missing, empty, or non-text argument gives the
 * fallback label. Any other tool gives `Using <toolName>`, so its arguments stay private.
 *
 * Input schema (`args`): an object whose relevant optional string field depends on the tool:
 *   - bash: command; read, edit, write, ls: path; grep, find: pattern.
 *
 * :param toolName: string; name of the tool that Pi is running.
 * :param args: unknown; tool arguments from the model, which may be malformed.
 * return label: string; unshortened label such as "Reading src/index.ts".
 */
export function describeToolWork(toolName: string, args: unknown): string {
	const rule = Object.hasOwn(TOOL_LABEL_RULES, toolName) ? TOOL_LABEL_RULES[toolName] : undefined;
	if (!rule) {
		return `Using ${toolName}`;
	}
	const value = (args as Record<string, unknown> | null | undefined)?.[rule.argumentName];
	if (typeof value !== "string" || value.trim() === "") {
		return rule.fallback;
	}
	return `${rule.verb} ${value}`;
}

/**
 * Track the model phase and the running tools and return the working row text.
 *
 * Running tools take priority over the model phase. Several tools can run in parallel, so
 * the tracker keeps them in start order and shows the newest one. Methods never throw.
 *
 * return instance: WorkStatusTracker; tracker in the thinking phase with no tools.
 */
export class WorkStatusTracker {
	private phaseLabel = THINKING_LABEL;
	private readonly runningTools = new Map<string, string>();

	/**
	 * Return the tracker to the thinking phase and forget all running tools.
	 *
	 * return None: None; no value is returned.
	 */
	reset(): void {
		this.phaseLabel = THINKING_LABEL;
		this.runningTools.clear();
	}

	/**
	 * Set the model phase to thinking.
	 *
	 * return None: None; no value is returned.
	 */
	markThinking(): void {
		this.phaseLabel = THINKING_LABEL;
	}

	/**
	 * Set the model phase to writing the answer.
	 *
	 * return None: None; no value is returned.
	 */
	markWriting(): void {
		this.phaseLabel = WRITING_LABEL;
	}

	/**
	 * Set the model phase to preparing a tool call.
	 *
	 * return None: None; no value is returned.
	 */
	markPreparingTool(): void {
		this.phaseLabel = PREPARING_TOOL_LABEL;
	}

	/**
	 * Record a running tool from its call identifier, name, and arguments.
	 *
	 * :param toolCallId: string; unique identifier of the tool call.
	 * :param toolName: string; name of the tool.
	 * :param args: unknown; tool arguments, as accepted by describeToolWork.
	 * return None: None; no value is returned.
	 */
	startTool(toolCallId: string, toolName: string, args: unknown): void {
		this.runningTools.set(toolCallId, describeToolWork(toolName, args));
	}

	/**
	 * Remove a finished tool by its call identifier.
	 *
	 * An unknown identifier has no effect.
	 *
	 * :param toolCallId: string; unique identifier of the tool call.
	 * return None: None; no value is returned.
	 */
	endTool(toolCallId: string): void {
		this.runningTools.delete(toolCallId);
	}

	/**
	 * Build the working row text and return it.
	 *
	 * The newest tool label is shortened before the ` (+N more)` suffix is added, so the
	 * suffix always stays visible.
	 *
	 * return label: string; clean text of at most MAX_DETAIL_LENGTH code points.
	 */
	readLabel(): string {
		const labels = Array.from(this.runningTools.values());
		const newestLabel = labels.at(-1);
		if (newestLabel === undefined) {
			return this.phaseLabel;
		}
		const suffix = labels.length > 1 ? ` (+${labels.length - 1} more)` : "";
		return `${sanitizeDetail(newestLabel, MAX_DETAIL_LENGTH - suffix.length)}${suffix}`;
	}
}
