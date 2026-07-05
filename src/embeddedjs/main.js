// PebHub - Unofficial GitHub Client for Pebble
// Alloy (Moddable) rewrite with CI monitoring and notifications
// Config schema mirrors daegalus/cinders

import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Vibes from "pebble/vibes";
import Timer from "timer";
import {getDeviceMetrics} from "device/board";

// ── Screen dimensions ──────────────────────────────────────────────
const metrics = getDeviceMetrics();
const WIDTH = screen.width;
const HEIGHT = screen.height;

// ── Color helpers (RGB 8-bit → 16-bit 565) ─────────────────────────
function rgb(r, g, b) {
	return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
}

const COLORS = {
	background: rgb(0, 0, 0),
	card:       rgb(24, 24, 28),
	text:       rgb(220, 220, 220),
	dim:        rgb(140, 140, 140),
	accent:     rgb(60, 130, 230),       // Pebble-like blue
	green:      rgb(60, 200, 80),        // CI passed
	red:        rgb(230, 70, 70),        // CI failed
	yellow:     rgb(230, 200, 40),       // CI in progress
	orange:     rgb(230, 150, 40),       // CI cancelled/skipped
	border:     rgb(50, 50, 55),
	headerBg:   rgb(16, 16, 20),
	successBg:  rgb(10, 30, 15),
	failBg:     rgb(30, 10, 10),
};

// ── App state ──────────────────────────────────────────────────────
const store = device.keyValue.open({path: "pebhub", format: "string"});

let state = {
	screen: "config",        // config | loading | feed | ci | detail
	token: store.read("token") || null,
	username: store.read("username") || null,
	userId: Number(store.read("userId")) || 0,
	forge: store.read("forge") || "github",
	url: store.read("url") || "github.com",
	authMethod: store.read("authMethod") || "token",
	// Filter which notification types to show (mirrors Cinders schema)
	notifTypes: JSON.parse(store.read("notifTypes") || '["Issue","PullRequest","CheckSuite"]'),
	excludedRepos: JSON.parse(store.read("excludedRepos") || '[]'),
	pollInterval: Number(store.read("pollInterval") || 300) * 1000,   // ms
	maxNotifs: Number(store.read("maxNotifs") || 50),
	maxCiRuns: Number(store.read("maxCiRuns") || 10),
	// Runtime
	notifications: [],
	ciRuns: [],
	feedScroll: 0,
	ciScroll: 0,
	selection: 0,
	failedCiSinceLastPoll: false,
	lastCheck: 0,
};

function saveToken(token, userId_, username_) {
	store.write("token", token);
	store.write("userId", String(userId_ || 0));
	store.write("username", username_ || "");
	state.token = token;
	state.userId = userId_ || 0;
	state.username = username_ || "";
}

function saveSetting(key, value) {
	store.write(key, String(value));
}

// ── GitHub API Client ──────────────────────────────────────────────
const GITHUB_API = "https://api.github.com";

async function githubFetch(path, options = {}) {
	if (!state.token) throw new Error("No token");
	const url = `${GITHUB_API}${path}`;
	const headers = {
		"Authorization": `Bearer ${state.token}`,
		"Accept": "application/vnd.github.v3+json",
		"User-Agent": "PebHub/1.0",
		...options.headers
	};
	const response = await fetch(url, {
		...options,
		headers
	});
	if (!response.ok) {
		if (response.status === 401) throw new Error("Bad credentials");
		if (response.status === 403) throw new Error("Rate limited or insufficient scopes");
		throw new Error(`GitHub API ${response.status}`);
	}
	return response.json();
}

// ── OAuth Device Flow ──────────────────────────────────────────────
async function startOAuth() {
	try {
		const resp = await fetch("https://github.com/login/device/code", {
			method: "POST",
			headers: {
				"Accept": "application/json",
				"Content-Type": "application/json",
				"User-Agent": "PebHub/1.0"
			},
			body: JSON.stringify({
				client_id: "Ov23lijMTchHO2KwEoJn",
				scope: "notifications read:user repo"
			})
		});
		const data = await resp.json();
		if (!data.device_code) throw new Error("OAuth start failed");
		return data;
	} catch (e) {
		throw e;
	}
}

async function pollOAuthToken(deviceCode, interval, expiresIn) {
	const deadline = Date.now() + (expiresIn * 1000);
	while (Date.now() < deadline) {
		await new Promise(resolve => Timer.set(resolve, interval * 1000));
		try {
			const resp = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: {
					"Accept": "application/json",
					"Content-Type": "application/json",
					"User-Agent": "PebHub/1.0"
				},
				body: JSON.stringify({
					client_id: "Ov23lijMTchHO2KwEoJn",
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code"
				})
			});
			const data = await resp.json();
			if (data.access_token) {
				// Get user info to store alongside token
				const userInfo = await githubFetch("/user", {
					headers: {"Authorization": `Bearer ${data.access_token}`}
				});
				saveToken(data.access_token, userInfo.id, userInfo.login);
				return data.access_token;
			}
			if (data.error === "authorization_pending") continue;
			if (data.error === "slow_down") { interval = Math.ceil(interval * 1.5); continue; }
			if (data.error === "expired_token" || data.error === "access_denied") break;
		} catch (e) {
			console.log(`OAuth poll error: ${e}`);
		}
	}
	return null;
}

// ── Data fetching ──────────────────────────────────────────────────
async function fetchNotifications() {
	try {
		const data = await githubFetch("/notifications?per_page=" + state.maxNotifs + "&all=false");
		const filtered = [];
		for (const item of data) {
			const repo = item.repository.full_name;
			// Check excluded repos (same as Cinders pattern)
			if (repoExcluded(repo)) continue;
			// Check notification type filter
			if (!state.notifTypes.includes(item.subject.type)) continue;

			let extra = {};
			if (item.subject.url) {
				try {
					const subjectResp = await fetch(item.subject.url, {
						headers: {
							"Authorization": `Bearer ${state.token}`,
							"Accept": "application/vnd.github.v3+json",
							"User-Agent": "PebHub/1.0"
						}
					});
					if (subjectResp.ok) {
						const subject = await subjectResp.json();
						extra.state = subject.state || "";
						extra.htmlUrl = subject.html_url || "";
						if (item.subject.type === "PullRequest") {
							if (subject.draft) extra.state = "draft";
							if (subject.state === "closed" && !subject.merged_at) extra.state = "denied";
							if (subject.merged_at) extra.state = "merged";
						}
					}
				} catch (e) {}
			}

			filtered.push({
				id: String(item.id),
				type: item.subject.type,
				title: item.subject.title,
				repository: repo,
				unread: item.unread,
				updatedAt: item.updated_at,
				state: extra.state || "",
				url: extra.htmlUrl || `https://github.com/${repo}`
			});
		}
		return filtered;
	} catch (e) {
		console.log(`fetchNotifications error: ${e}`);
		return [];
	}
}

async function fetchCiRuns() {
	try {
		const repos = await githubFetch("/user/repos?per_page=20&sort=pushed&type=owner");
		const results = [];

		const exclude = state.excludedRepos;
		const checkRuns = async (repo) => {
			const fullName = repo.full_name;
			if (repoExcluded(fullName)) return;
			try {
				const runs = await githubFetch(`/repos/${fullName}/actions/runs?per_page=5&page=1`);
				for (const run of runs.workflow_runs || []) {
					if (results.length >= state.maxCiRuns) return;
					results.push({
						id: String(run.id),
						name: run.name || run.event,
						workflow: run.display_title || run.name || run.event,
						repository: fullName,
						branch: run.head_branch,
						status: run.status,
						conclusion: run.conclusion,
						createdAt: run.created_at,
						updatedAt: run.updated_at,
						runNumber: run.run_number,
						event: run.event,
						url: run.html_url
					});
				}
			} catch (e) {
				// No Actions access for this repo, skip
			}
		};

		for (const repo of repos) {
			if (results.length >= state.maxCiRuns) break;
			await checkRuns(repo);
		}

		return results;
	} catch (e) {
		console.log(`fetchCiRuns error: ${e}`);
		return [];
	}
}

function repoExcluded(repo) {
	for (const filter of state.excludedRepos) {
		const f = filter.trim().toLowerCase();
		if (!f) continue;
		if (f.startsWith("/")) {
			// Regex pattern: /pattern/
			const end = f.lastIndexOf("/");
			if (end > 1) {
				try {
					const pat = new RegExp(f.slice(1, end), f.slice(end + 1));
					if (pat.test(repo)) return true;
				} catch (_) {}
			}
		} else {
			const [owner] = repo.split("/");
			if (f.includes("/")) {
				if (repo.toLowerCase() === f) return true;
			} else {
				if (owner.toLowerCase() === f) return true;
			}
		}
	}
	return false;
}

// ── Background polling ─────────────────────────────────────────────
let pollTimer = null;

function startPolling() {
	stopPolling();
	poll();
	pollTimer = Timer.repeat(poll, state.pollInterval);
}

function stopPolling() {
	if (pollTimer) {
		Timer.clear(pollTimer);
		pollTimer = null;
	}
}

async function poll() {
	if (!state.token) return;
	console.log("PebHub: polling GitHub");

	const prevFailedCount = state.notifications.filter(n => n.type === "CheckSuite" && n.state === "failure").length;

	const [notifs, ci] = await Promise.all([fetchNotifications(), fetchCiRuns()]);

	state.notifications = notifs;
	state.ciRuns = ci;
	state.lastCheck = Date.now();

	// Check for new CI failures and vibrate
	const newFailedCount = notifs.filter(n => n.type === "CheckSuite" && n.state === "failure").length;
	if (newFailedCount > prevFailedCount) {
		state.failedCiSinceLastPoll = true;
		Vibes.doublePulse();
	}

	// Check for any new CI failures in the runs
	for (const run of ci) {
		if (run.conclusion === "failure" || run.conclusion === "cancelled") {
			state.failedCiSinceLastPoll = true;
			Vibes.shortPulse();
			break;
		}
	}

	render();
}

// ── Rendering ──────────────────────────────────────────────────────
let gfx = new Poco(screen);

const LINE_H = 18;
const ITEM_H = 36;
const HEADER_H = 30;
const MARGIN = 4;
const SMALL = new gfx.Font("Bitham-Black", 16);
const LARGE = new gfx.Font("Bitham-Black", 20);
const TINY = new gfx.Font("Bitham-Black", 13);

// Icons (drawn as simple shapes since we don't have image textures for these)
function drawIcon(x, y, type, state_) {
	const g = gfx;
	const r = 5;
	const cx = x + 10;
	const cy = y + ITEM_H / 2;

	switch (type) {
		case "Issue":
			gfx.fillRectangle(COLORS.green, cx - r, cy - r, r * 2, r * 2);
			if (state_ === "closed") gfx.fillRectangle(COLORS.dim, cx - r, cy - r, r * 2, r * 2);
			break;
		case "PullRequest":
			if (state_ === "merged") {
				// Purple-ish for merged
				gfx.fillRectangle(rgb(130, 80, 200), cx - r, cy - r, 3, r * 2);
				gfx.fillRectangle(rgb(130, 80, 200), cx - 2, cy, r * 2, 3);
			} else if (state_ === "denied" || state_ === "closed") {
				gfx.fillRectangle(COLORS.red, cx - r, cy - r, r * 2, r * 2);
			} else if (state_ === "draft") {
				gfx.fillRectangle(COLORS.dim, cx - r, cy - r, r * 2, r * 2);
			} else {
				gfx.fillRectangle(COLORS.accent, cx - r, cy - r, r * 2, r * 2);
			}
			break;
		case "CheckSuite":
			if (state_ === "failure" || state_ === "cancelled") {
				gfx.fillRectangle(COLORS.red, cx - r, cy - r, r * 2, r * 2);
			} else {
				gfx.fillRectangle(COLORS.green, cx - r, cy - r, r * 2, r * 2);
			}
			break;
		default:
			gfx.fillRectangle(COLORS.dim, cx - r, cy - r, r * 2, r * 2);
	}
}

function drawCiIcon(x, y, conclusion, status) {
	const g = gfx;
	const cx = x + 10;
	const cy = y + ITEM_H / 2;
	const r = 5;

	let color;
	if (conclusion === "success") color = COLORS.green;
	else if (conclusion === "failure") color = COLORS.red;
	else if (conclusion === "cancelled" || conclusion === "skipped") color = COLORS.orange;
	else if (status === "in_progress" || status === "queued" || status === "pending") color = COLORS.yellow;
	else color = COLORS.dim;

	gfx.fillRectangle(color, cx - r, cy - r, r * 2, r * 2);
}

function getCiStatusLabel(conclusion, status) {
	if (conclusion === "success") return "passed";
	if (conclusion === "failure") return "failed";
	if (conclusion === "cancelled") return "cancelled";
	if (conclusion === "skipped") return "skipped";
	if (status === "in_progress") return "running";
	if (status === "queued") return "queued";
	if (status === "pending") return "pending";
	return "unknown";
}

function getCiStatusColor(conclusion, status) {
	if (conclusion === "success") return COLORS.green;
	if (conclusion === "failure") return COLORS.red;
	if (conclusion === "cancelled" || conclusion === "skipped") return COLORS.orange;
	if (status === "in_progress") return COLORS.yellow;
	return COLORS.dim;
}

// ── Screen rendering ──────────────────────────────────────────────
function renderSplash(msg) {
	gfx.begin();
	gfx.fillRectangle(COLORS.background, 0, 0, WIDTH, HEIGHT);

	const msgW = gfx.getTextWidth(msg, SMALL);
	gfx.drawText(msg, SMALL, COLORS.dim,
		(WIDTH - msgW) / 2, HEIGHT / 2 - 10);

	gfx.end();
}

function renderSetup() {
	gfx.begin();
	gfx.fillRectangle(COLORS.background, 0, 0, WIDTH, HEIGHT);

	// Title
	const title = "PebHub";
	const tw = gfx.getTextWidth(title, LARGE);
	gfx.drawText(title, LARGE, COLORS.text, (WIDTH - tw) / 2, 15);

	// Instructions
	const lines = [
		"Not set up yet!",
		"",
		"Open the Pebble app",
		"on your phone to",
		"configure GitHub",
		"access in PebHub.",
		"",
		"Or press SELECT to",
		"start OAuth Device Flow",
		"(enter the code at",
		"github.com/login/device)"
	];

	let y = 60;
	for (const line of lines) {
		const lw = gfx.getTextWidth(line, TINY);
		gfx.drawText(line, TINY, COLORS.dim, (WIDTH - lw) / 2, y);
		y += 16;
	}

	gfx.end();
}

function renderFeed() {
	gfx.begin();
	gfx.fillRectangle(COLORS.background, 0, 0, WIDTH, HEIGHT);

	// Header bar
	gfx.fillRectangle(COLORS.headerBg, 0, 0, WIDTH, HEADER_H);
	gfx.drawText("PebHub", SMALL, COLORS.text, 8, 6);

	// Notification count
	const count = state.notifications.length;
	const countStr = String(count);
	const cw = gfx.getTextWidth(countStr, TINY);
	const countColor = state.failedCiSinceLastPoll ? COLORS.red : COLORS.dim;
	gfx.drawText(countStr, TINY, countColor, WIDTH - cw - 8, 8);

	// Separator
	gfx.fillRectangle(COLORS.border, 0, HEADER_H, WIDTH, 1);

	// Notification items
	const visibleLines = Math.floor((HEIGHT - HEADER_H) / ITEM_H);
	const startIdx = state.feedScroll;

	for (let i = 0; i < visibleLines && (startIdx + i) < state.notifications.length; i++) {
		const item = state.notifications[startIdx + i];
		const y = HEADER_H + i * ITEM_H;

		// Selection highlight
		if ((startIdx + i) === state.selection) {
			gfx.fillRectangle(COLORS.card, 0, y, WIDTH, ITEM_H);
		}

		// Icon
		drawIcon(4, y, item.type, item.state);

		// Title (truncated)
		const title = item.title.length > 24 ? item.title.slice(0, 22) + ".." : item.title;
		gfx.drawText(title, TINY, COLORS.text, 22, y + 4);

		// Subtitle: repo + relative time
		const repo = item.repository.length > 18 ? "..." + item.repository.slice(-16) : item.repository;
		gfx.drawText(repo, TINY, COLORS.dim, 22, y + 20);

		// Unread indicator
		if (item.unread) {
			gfx.fillRectangle(COLORS.accent, WIDTH - 6, y + (ITEM_H / 2) - 2, 4, 4);
		}

		// Separator
		if (i < visibleLines - 1) {
			gfx.fillRectangle(COLORS.border, 20, y + ITEM_H - 1, WIDTH - 20, 1);
		}
	}

	// Empty state
	if (state.notifications.length === 0) {
		const msg = "No notifications";
		const mw = gfx.getTextWidth(msg, SMALL);
		gfx.drawText(msg, SMALL, COLORS.dim, (WIDTH - mw) / 2, HEIGHT / 2 - 10);
	}

	// Header hint
	const hint = "Up/Down scroll  Select detail  Back:CI";
	const hw = gfx.getTextWidth(hint, TINY);
	gfx.drawText(hint, TINY, COLORS.dim, WIDTH - hw - 4, 8);

	gfx.end();
}

function renderCiDashboard() {
	gfx.begin();
	gfx.fillRectangle(COLORS.background, 0, 0, WIDTH, HEIGHT);

	// Header bar
	gfx.fillRectangle(COLORS.headerBg, 0, 0, WIDTH, HEADER_H);
	gfx.drawText("CI Status", SMALL, COLORS.text, 8, 6);

	// Timestamp
	if (state.lastCheck > 0) {
		const ago = Math.round((Date.now() - state.lastCheck) / 60000) + "m ago";
		const aw = gfx.getTextWidth(ago, TINY);
		gfx.drawText(ago, TINY, COLORS.dim, WIDTH - aw - 8, 8);
	}

	// Separator
	gfx.fillRectangle(COLORS.border, 0, HEADER_H, WIDTH, 1);

	// CI items
	const visibleLines = Math.floor((HEIGHT - HEADER_H) / ITEM_H);
	const startIdx = state.ciScroll;

	for (let i = 0; i < visibleLines && (startIdx + i) < state.ciRuns.length; i++) {
		const run = state.ciRuns[startIdx + i];
		const y = HEADER_H + i * ITEM_H;

		// Selection highlight
		if ((startIdx + i) === state.selection) {
			gfx.fillRectangle(COLORS.card, 0, y, WIDTH, ITEM_H);
		}

		// CI status icon
		drawCiIcon(4, y, run.conclusion, run.status);

		// Workflow name (truncated)
		const name = run.workflow.length > 22 ? run.workflow.slice(0, 20) + ".." : run.workflow;
		gfx.drawText(name, TINY, COLORS.text, 22, y + 2);

		// Branch
		const branch = run.branch ? (run.branch.length > 14 ? run.branch.slice(0, 12) + ".." : run.branch) : "";
		gfx.drawText(branch, TINY, COLORS.dim, 22, y + 17);

		// Status label
		const statusLabel = getCiStatusLabel(run.conclusion, run.status);
		const statusColor = getCiStatusColor(run.conclusion, run.status);
		const sw = gfx.getTextWidth(statusLabel, TINY);
		gfx.drawText(statusLabel, TINY, statusColor, WIDTH - sw - 6, y + 2);

		// Separator
		if (i < visibleLines - 1) {
			gfx.fillRectangle(COLORS.border, 20, y + ITEM_H - 1, WIDTH - 20, 1);
		}
	}

	// Empty state
	if (state.ciRuns.length === 0) {
		const msg = "No CI runs found";
		const mw = gfx.getTextWidth(msg, SMALL);
		gfx.drawText(msg, SMALL, COLORS.dim, (WIDTH - mw) / 2, HEIGHT / 2 - 10);
	}

	// Header hint
	const hint = "Back:Feed  Select detail";
	const hw = gfx.getTextWidth(hint, TINY);
	gfx.drawText(hint, TINY, COLORS.dim, WIDTH - hw - 4, 8);

	gfx.end();
}

function renderDetail(item, isCi) {
	gfx.begin();
	gfx.fillRectangle(COLORS.background, 0, 0, WIDTH, HEIGHT);

	// Back indicator
	gfx.fillRectangle(rgb(20, 20, 25), 0, 0, WIDTH, 22);
	gfx.drawText("< Back", TINY, COLORS.dim, 6, 4);

	// Title
	let title = item.title || item.name || item.workflow || "Detail";
	if (title.length > 28) title = title.slice(0, 26) + "..";
	gfx.drawText(title, SMALL, COLORS.text, 6, 30);

	let y = 56;
	const lineH = 16;

	// Type / status badge
	if (isCi) {
		const statusLabel = getCiStatusLabel(item.conclusion, item.status);
		const statusColor = getCiStatusColor(item.conclusion, item.status);
		gfx.drawText(`Status: `, TINY, COLORS.dim, 6, y);
		const sw = gfx.getTextWidth(statusLabel, TINY);
		const slw = gfx.getTextWidth("Status: ", TINY);
		gfx.drawText(statusLabel, TINY, statusColor, 6 + slw, y);
	} else {
		gfx.drawText(`Type: ${item.type}`, TINY, COLORS.dim, 6, y);
	}
	y += lineH;

	// Repository
	gfx.drawText(`Repo: ${item.repository}`, TINY, COLORS.dim, 6, y);
	y += lineH;

	if (isCi) {
		// Branch
		if (item.branch) {
			gfx.drawText(`Branch: ${item.branch}`, TINY, COLORS.dim, 6, y);
			y += lineH;
		}
		// Event
		if (item.event) {
			gfx.drawText(`Event: ${item.event}`, TINY, COLORS.dim, 6, y);
			y += lineH;
		}
		// Run number
		gfx.drawText(`Run #${item.runNumber}`, TINY, COLORS.dim, 6, y);
		y += lineH;
	} else {
		// State
		if (item.state) {
			gfx.drawText(`State: ${item.state}`, TINY, COLORS.dim, 6, y);
			y += lineH;
		}
	}

	// Updated at
	if (item.updatedAt) {
		const date = new Date(item.updatedAt);
		gfx.drawText(`Updated: ${date.toLocaleDateString()} ${date.toLocaleTimeString().slice(0, 5)}`, TINY, COLORS.dim, 6, y);
		y += lineH;
	}

	gfx.end();
}

function render() {
	switch (state.screen) {
		case "config":
			renderSetup();
			break;
		case "loading":
			renderSplash("Loading...");
			break;
		case "feed":
			renderFeed();
			break;
		case "ci":
			renderCiDashboard();
			break;
		case "detail":
			// detail is rendered by the calling function with the item
			break;
	}
}

// ── OAuth Flow (on-watch) ─────────────────────────────────────────
let oauthPhase = 0; // 0=inactive, 1=got code, 2=polling

async function startOAuthOnWatch() {
	state.screen = "loading";
	renderSplash("Starting OAuth...");

	try {
		const {device_code, user_code, verification_uri, interval, expires_in} = await startOAuth();

		// Show the code on screen
		gfx.begin();
		gfx.fillRectangle(COLORS.background, 0, 0, WIDTH, HEIGHT);
		gfx.drawText("OAuth Setup", SMALL, COLORS.text, 6, 10);

		const lines = [
			"1. Open a browser at:",
			verification_uri || "github.com/login/device",
			"",
			"2. Enter this code:",
		];
		let y = 40;
		for (const l of lines) {
			const lw = gfx.getTextWidth(l, TINY);
			gfx.drawText(l, TINY, COLORS.dim, (WIDTH - lw) / 2, y);
			y += 18;
		}

		// Big code
		const codeW = gfx.getTextWidth(user_code, LARGE);
		gfx.drawText(user_code, LARGE, COLORS.accent, (WIDTH - codeW) / 2, y);
		y += 30;

		gfx.drawText("3. Press SELECT when done", TINY, COLORS.dim, 6, y);
		gfx.drawText("or BACK to cancel", TINY, COLORS.dim, 6, y + 16);

		gfx.end();

		oauthPhase = 1;
		state._oauthData = {device_code, interval, expires_in};

	} catch (e) {
		renderSplash("OAuth Error: " + e.message);
	}
}

// ── Init & lifecycle ───────────────────────────────────────────────
async function init() {
	console.log("PebHub v1.0 starting");

	// Button handling
	new Button({
		types: ["select", "up", "down", "back"],
		onPush(down, type) {
			if (down) return;  // Only handle button release

			if (state.screen === "config") {
				if (type === "select") {
					startOAuthOnWatch();
				}
				return;
			}

			if (state.screen === "feed") {
				switch (type) {
					case "up":
						if (state.selection > 0) {
							state.selection--;
							if (state.selection < state.feedScroll) state.feedScroll = state.selection;
							render();
						}
						break;
					case "down":
						if (state.selection < state.notifications.length - 1) {
							state.selection++;
							const visible = Math.floor((HEIGHT - HEADER_H) / ITEM_H);
							if (state.selection >= state.feedScroll + visible - 1) state.feedScroll = state.selection - visible + 2;
							render();
						}
						break;
					case "select":
						if (state.notifications[state.selection]) {
							state.screen = "detail";
							renderDetail(state.notifications[state.selection], false);
						}
						break;
					case "back":
						state.screen = "ci";
						state.selection = 0;
						state.ciScroll = 0;
						render();
						break;
				}
				return;
			}

			if (state.screen === "ci") {
				switch (type) {
					case "up":
						if (state.selection > 0) {
							state.selection--;
							if (state.selection < state.ciScroll) state.ciScroll = state.selection;
							render();
						}
						break;
					case "down":
						if (state.selection < state.ciRuns.length - 1) {
							state.selection++;
							const visible = Math.floor((HEIGHT - HEADER_H) / ITEM_H);
							if (state.selection >= state.ciScroll + visible - 1) state.ciScroll = state.selection - visible + 2;
							render();
						}
						break;
					case "select":
						if (state.ciRuns[state.selection]) {
							state.screen = "detail";
							renderDetail(state.ciRuns[state.selection], true);
						}
						break;
					case "back":
						state.screen = "feed";
						state.selection = 0;
						state.feedScroll = 0;
						render();
						break;
				}
				return;
			}

			if (state.screen === "detail") {
				if (type === "back") {
					// Go back to feed or CI depending on what we came from
					const lastScreen = state.ciRuns.length > 0 ? "feed" : "feed";
					state.screen = lastScreen;
					render();
				}
				return;
			}
		}
	});

	// Check if configured
	if (state.token) {
		state.screen = "loading";
		renderSplash("Loading...");
		try {
			// Verify token
			const user = await githubFetch("/user");
			state.userId = user.id;
			state.username = user.login;
			saveSetting("userId", String(user.id));
			saveSetting("username", user.login);

			// Initial fetch
			const [notifs, ci] = await Promise.all([fetchNotifications(), fetchCiRuns()]);
			state.notifications = notifs;
			state.ciRuns = ci;
			state.lastCheck = Date.now();

			state.screen = "feed";
			render();

			// Start background polling
			startPolling();
		} catch (e) {
			console.log(`Init error: ${e}`);
			if (e.message === "Bad credentials") {
				saveToken("", 0, "");  // Clear bad token
			}
			state.screen = "config";
			render();
		}
	} else {
		state.screen = "config";
		render();
	}
}

init();

export {};
