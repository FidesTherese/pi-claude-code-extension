/**
 * Alternates the terminal title between a green and a red circle while Pi works.
 * This file imports nothing from Pi, so its tests run without the host.
 */

import { basename } from "node:path";

export const BLINK_INTERVAL_MS = 500;

const GREEN_CIRCLE = "🟢";
const RED_CIRCLE = "🔴";

/**
 * Build Pi's normal terminal title from a folder and a session name and return it.
 *
 * Pi does not expose its title to extensions, so this function repeats the format of
 * `updateTerminalTitle` in Pi 1.4.0.
 *
 * :param cwd: string; working directory of the session.
 * :param sessionName: string | undefined; session name, or undefined when unnamed.
 * return title: string; for example "π - my-project".
 */
export function formatBaseTitle(cwd: string, sessionName: string | undefined): string {
	const folder = basename(cwd);
	return sessionName ? `π - ${sessionName} - ${folder}` : `π - ${folder}`;
}

/**
 * Alternate the title on a timer and restore the normal title when stopped.
 *
 * The class reads the base title on every tick, so a session rename appears at the next
 * tick. The timer never keeps the process alive. Both start and stop are idempotent.
 *
 * :param setTitle: (title: string) => void; writes the terminal title.
 * :param readBaseTitle: () => string; returns the normal title without a circle.
 * return instance: TitleBlinker; stopped blinker.
 */
export class TitleBlinker {
	private readonly setTitle: (title: string) => void;
	private readonly readBaseTitle: () => string;
	private timer: ReturnType<typeof setInterval> | null = null;
	private isGreen = true;

	constructor(setTitle: (title: string) => void, readBaseTitle: () => string) {
		this.setTitle = setTitle;
		this.readBaseTitle = readBaseTitle;
	}

	/**
	 * Show the green circle at once and start alternating.
	 *
	 * The call has no effect while the blinker is already running.
	 *
	 * return None: None; no value is returned.
	 */
	start(): void {
		if (this.timer) {
			return;
		}
		this.isGreen = true;
		this.writeCircleTitle();
		this.timer = setInterval(() => {
			this.isGreen = !this.isGreen;
			this.writeCircleTitle();
		}, BLINK_INTERVAL_MS);
		this.timer.unref?.();
	}

	/**
	 * Stop alternating and restore the normal title.
	 *
	 * The call has no effect while the blinker is stopped.
	 *
	 * return None: None; no value is returned.
	 */
	stop(): void {
		if (!this.timer) {
			return;
		}
		clearInterval(this.timer);
		this.timer = null;
		this.setTitle(this.readBaseTitle());
	}

	/**
	 * Write the title with the circle that matches the current state.
	 *
	 * return None: None; no value is returned.
	 */
	private writeCircleTitle(): void {
		const circle = this.isGreen ? GREEN_CIRCLE : RED_CIRCLE;
		this.setTitle(`${circle} ${this.readBaseTitle()}`);
	}
}
