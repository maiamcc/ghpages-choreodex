// ============================================================
// program-print.js — drives the Paged.js program print preview.
//
// The page ships an un-paginated `#print-source` (hidden) plus an empty
// `#print-render`. On every settings change we clone + filter the source
// per the sidebar form, build a dynamic @page stylesheet, and hand both to
// Paged.js, which paginates real page boxes into `#print-render`. Because
// Paged.js renders those boxes on screen with the same CSS it prints with,
// the preview is what prints.
//
// Re-render hygiene (verified against pagedjs 0.4.3 internals):
//   • Pass a CLONE — Paged's ContentParser stamps data-ref on the node.
//   • Create a fresh Previewer each render.
//   • Before each render, remove the styles Paged injected last time
//     (`style[data-pagedjs-inserted-styles]`) and clear the render target,
//     otherwise stale @page rules accumulate.
// ============================================================
const PATH_PREFIX = (window.PATH_PREFIX || "/").replace(/\/$/, "");

const form = document.getElementById("print-settings-form");
const source = document.getElementById("print-source");
const renderTarget = document.getElementById("print-render");
const printBtn = document.getElementById("print-trigger-btn");
const pdfBtn = document.getElementById("print-pdf-btn");
const pdfStatus = document.getElementById("print-pdf-status");

const sectionsFieldset = document.getElementById("print-sections-fieldset");
const cardOptionsFieldset = document.getElementById("print-card-options-fieldset");
const cardOptionsDivider = document.getElementById("print-card-options-divider");
const tableColsFieldset = document.getElementById("print-table-cols-fieldset");
const tableColsDivider = document.getElementById("print-table-cols-divider");
const customFields = document.getElementById("print-custom-size-fields");
const orientHint = document.getElementById("print-orient-hint");
const textValueEl = document.getElementById("print-text-value");
const textDecBtn = document.getElementById("print-text-dec");
const textIncBtn = document.getElementById("print-text-inc");

// Card-part name → selector(s) within a dance card.
const PART_SELECTORS = {
	"choreo": ".choreography-section",
	"tunes": ".tunes-section, .tune-inline",
	"teaching-notes": ".teaching-notes-section",
	"notes": ".background-section",
};

// Page-size presets, in inches. Margins assume the OS print dialog has
// "Headers and Footers" disabled and margins set to Default.
const PAGE_SIZES = {
	letter: { w: 8.5, h: 11, margin: 1 },
	"3x5": { w: 3, h: 5, margin: 0.25 },
	"4x6": { w: 4, h: 6, margin: 0.375 },
};
const CUSTOM_MARGIN = 0.5;

// Safari (and every iOS browser, which is WebKit underneath) ignores
// @page { margin: 0 }, so Paged.js's full-sheet page boxes overflow Safari's
// own forced print margins and spill a blank page after every page. There's
// no CSS that makes Safari honor margin:0, so native print is a lost cause
// on WebKit — we hide the Print button there and steer Safari users to
// "Open as PDF" (client-side, browser-independent). Detect WebKit for that.
const UA = navigator.userAgent;
const IS_IOS = /iP(hone|ad|od)/.test(UA) ||
	(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_SAFARI = /safari/i.test(UA) && !/chrome|chromium|crios|fxios|android|edg/i.test(UA);
const IS_WEBKIT_PRINT = IS_IOS || IS_SAFARI;
// Page-size <select> values that are safe to apply (anything else — e.g. a
// hand-crafted ?page=foo — would leave the <select> with an empty value).
const VALID_PAGE_SIZES = ["letter", "3x5", "4x6", "custom"];
// Text-size slider stops (base font in pt) and their labels; same URL-safety
// rationale as the page sizes.
const TEXT_SIZES = ["8", "9", "10", "11", "12"];
const TEXT_SIZE_NAMES = { 8: "Tiny", 9: "Small", 10: "Normal", 11: "Large", 12: "Extra large" };
const DEFAULT_TEXT_SIZE = 10;
const TEXT_SIZE_MIN = Number(TEXT_SIZES[0]);
const TEXT_SIZE_MAX = Number(TEXT_SIZES[TEXT_SIZES.length - 1]);
// Mirror the custom-size inputs' min/max so URL-supplied dimensions can't
// produce a page smaller than its own margins (a blank Paged.js layout).
const DIM_MIN = 1;
const DIM_MAX = 36;

function clampDim(value, fallback) {
	const v = parseFloat(value);
	if (!(v > 0)) return fallback;
	return Math.min(DIM_MAX, Math.max(DIM_MIN, v));
}

// ── Read form helpers ─────────────────────────────────────────

function isChecked(selector) {
	const el = form.querySelector(selector);
	return el ? el.checked : false;
}

function setChecked(selector, checked) {
	const el = form.querySelector(selector);
	if (el) el.checked = checked;
}

// Split a comma-separated param, dropping empty tokens. Empty string → []
// so an all-unchecked selection, which persists as ?sections= / ?cols=,
// round-trips back to all-unchecked rather than re-checking a first value.
function toList(str) {
	return str.split(",").filter((s) => s.trim() !== "");
}

function colCheckboxes() {
	return Array.from(form.querySelectorAll('[name="print-col"]'));
}

// Set of column keys ("title", "year", …) the user has checked. Keys match
// the col-{key} classes program-table-core.njk stamps on every cell.
function selectedCols() {
	const keep = new Set();
	form.querySelectorAll('[name="print-col"]:checked').forEach((cb) => keep.add(cb.value));
	return keep;
}

// User-chosen page orientation. Applies to the TOC/cards segment; the table
// segment always prints landscape regardless (it's too wide for portrait).
function currentOrientation() {
	const r = form.querySelector('[name="print-orient"]:checked');
	return r && r.value === "landscape" ? "landscape" : "portrait";
}

// Base font size in pt for the rendered pages (default 10).
function currentTextSize() {
	const el = form.querySelector('[name="print-text-size"]');
	return el && TEXT_SIZES.includes(el.value) ? Number(el.value) : DEFAULT_TEXT_SIZE;
}

function currentPageSize() {
	const sizeEl = form.querySelector('[name="print-page-size"]');
	const val = sizeEl ? sizeEl.value : "letter";
	if (val === "custom") {
		const wEl = form.querySelector('[name="print-page-width"]');
		const hEl = form.querySelector('[name="print-page-height"]');
		return {
			w: clampDim(wEl && wEl.value, 8.5),
			h: clampDim(hEl && hEl.value, 11),
			margin: CUSTOM_MARGIN,
		};
	}
	return PAGE_SIZES[val] || PAGE_SIZES.letter;
}

// ── Initialize form from URL params ───────────────────────────

function initFromParams() {
	const params = new URLSearchParams(window.location.search);

	if (params.has("views")) {
		const views = new Set(params.get("views").split(","));
		setChecked('[name="print-toc"]', views.has("toc"));
		setChecked('[name="print-cards"]', views.has("cards"));
		setChecked('[name="print-table"]', views.has("table"));
	}

	if (params.has("sections")) {
		const sects = new Set(toList(params.get("sections")).map(Number));
		form.querySelectorAll('[name="print-section"]').forEach((cb) => {
			cb.checked = sects.has(Number(cb.value));
		});
	}

	if (params.has("parts")) {
		const parts = new Set(params.get("parts").split(","));
		Object.keys(PART_SELECTORS).forEach((key) => {
			setChecked(`[name="print-card-${key}"]`, parts.has(key));
		});
	}

	if (params.has("cols")) {
		const cols = new Set(toList(params.get("cols")));
		colCheckboxes().forEach((cb) => {
			cb.checked = cols.has(cb.value);
		});
	}

	if (params.get("orient") === "landscape") {
		const r = form.querySelector('[name="print-orient"][value="landscape"]');
		if (r) r.checked = true;
	}

	if (params.has("text") && TEXT_SIZES.includes(params.get("text"))) {
		const el = form.querySelector('[name="print-text-size"]');
		if (el) el.value = params.get("text");
	}

	if (params.has("page") && VALID_PAGE_SIZES.includes(params.get("page"))) {
		const pageVal = params.get("page");
		const sizeEl = form.querySelector('[name="print-page-size"]');
		if (sizeEl) sizeEl.value = pageVal;
		if (pageVal === "custom") {
			if (params.has("pw")) {
				const wEl = form.querySelector('[name="print-page-width"]');
				if (wEl) wEl.value = params.get("pw");
			}
			if (params.has("ph")) {
				const hEl = form.querySelector('[name="print-page-height"]');
				if (hEl) hEl.value = params.get("ph");
			}
		}
	}
}

// ── Persist settings in URL ───────────────────────────────────

function updateURLParams() {
	const params = new URLSearchParams();

	const views = [];
	if (isChecked('[name="print-toc"]')) views.push("toc");
	if (isChecked('[name="print-cards"]')) views.push("cards");
	if (isChecked('[name="print-table"]')) views.push("table");
	if (!(views.length === 2 && views.includes("toc") && views.includes("cards"))) {
		params.set("views", views.join(","));
	}

	const sectionCbs = Array.from(form.querySelectorAll('[name="print-section"]'));
	if (sectionCbs.length && sectionCbs.some((cb) => !cb.checked)) {
		params.set("sections", sectionCbs.filter((cb) => cb.checked).map((cb) => cb.value).join(","));
	}

	const allParts = Object.keys(PART_SELECTORS);
	const checkedParts = allParts.filter((key) => isChecked(`[name="print-card-${key}"]`));
	if (checkedParts.length < allParts.length) {
		params.set("parts", checkedParts.join(","));
	}

	const colCbs = colCheckboxes();
	if (colCbs.some((cb) => !cb.checked)) {
		params.set("cols", colCbs.filter((cb) => cb.checked).map((cb) => cb.value).join(","));
	}

	if (currentOrientation() === "landscape") params.set("orient", "landscape");
	if (currentTextSize() !== DEFAULT_TEXT_SIZE) params.set("text", String(currentTextSize()));

	const pageSizeEl = form.querySelector('[name="print-page-size"]');
	const pageSizeVal = pageSizeEl ? pageSizeEl.value : "letter";
	if (pageSizeVal !== "letter") params.set("page", pageSizeVal);
	if (pageSizeVal === "custom") {
		const pwEl = form.querySelector('[name="print-page-width"]');
		const phEl = form.querySelector('[name="print-page-height"]');
		if (pwEl && pwEl.value) params.set("pw", pwEl.value);
		if (phEl && phEl.value) params.set("ph", phEl.value);
	}

	const url = new URL(window.location.href);
	url.search = params.toString();
	history.replaceState(null, "", url);
}

// ── Sidebar fieldset visibility (no pagination) ───────────────

function updateSidebarState() {
	const tocChecked = isChecked('[name="print-toc"]');
	const cardsChecked = isChecked('[name="print-cards"]');
	const tableChecked = isChecked('[name="print-table"]');

	if (sectionsFieldset) {
		// The sections filter applies to every view (the table's tbodies carry
		// data-section-index too), so show it whenever anything is selected.
		sectionsFieldset.hidden = !(tocChecked || cardsChecked || tableChecked);
	}
	if (cardOptionsFieldset) {
		cardOptionsFieldset.hidden = !cardsChecked;
		if (cardOptionsDivider) cardOptionsDivider.hidden = !cardsChecked;
	}
	if (tableColsFieldset) {
		tableColsFieldset.hidden = !tableChecked;
		if (tableColsDivider) tableColsDivider.hidden = !tableChecked;
	}
	if (customFields) {
		const sizeEl = form.querySelector('[name="print-page-size"]');
		customFields.hidden = !(sizeEl && sizeEl.value === "custom");
	}
	if (orientHint) {
		// Only worth pointing out when the toggle and the table disagree.
		orientHint.hidden = !(tableChecked && currentOrientation() === "portrait");
	}
	updateTextSizeLabel();
}

// Reflect the slider's value in the readout ("Normal · 10 pt") and grey out a
// stepper button at its extreme. Cheap (no pagination) — safe to call live as
// the slider drags.
function updateTextSizeLabel() {
	const val = currentTextSize();
	if (textValueEl) textValueEl.textContent = `${TEXT_SIZE_NAMES[val]} · ${val} pt`;
	if (textDecBtn) textDecBtn.disabled = val <= TEXT_SIZE_MIN;
	if (textIncBtn) textIncBtn.disabled = val >= TEXT_SIZE_MAX;
}

// The A−/A＋ buttons nudge the slider one stop and re-render. Programmatic
// value changes don't fire input/change, so drive the update path directly.
function stepTextSize(delta) {
	const range = form.querySelector('[name="print-text-size"]');
	if (!range) return;
	const next = Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, currentTextSize() + delta));
	if (next === currentTextSize()) return;
	range.value = String(next);
	onSettingsChange();
}

// ── Build the filtered content clone for Paged.js ─────────────

function removeTableColumns(table, keep) {
	// Every col/th/td carries a col-{key} class (program-table-core.njk), so
	// unkept columns are removed by name — no positional index bookkeeping.
	colCheckboxes().forEach((cb) => {
		if (keep.has(cb.value)) return;
		table.querySelectorAll(`.col-${cb.value}`).forEach((el) => el.remove());
	});

	// Section/missing rows span the full width; colspan must be >= 1 even if
	// the user somehow deselected every column.
	const span = String(Math.max(keep.size, 1));
	table.querySelectorAll("tbody tr td[colspan]").forEach((td) => {
		td.setAttribute("colspan", span);
	});
}

// Build a filtered content clone holding just the views named in `keep`
// ({toc, cards, table} booleans). Splitting the views into separate clones
// lets each render at its own orientation (the table always landscape).
function buildContent(keep) {
	const clone = source.cloneNode(true);
	clone.removeAttribute("id");
	clone.removeAttribute("hidden");

	// Views
	removeIf(clone, '[data-print-view="toc"]', !keep.toc);
	removeIf(clone, '[data-print-view="cards"]', !keep.cards);
	removeIf(clone, '[data-print-view="table"]', !keep.table);

	// Sections — drop unchecked [data-section-index] blocks (all views)
	clone.querySelectorAll("[data-section-index]").forEach((el) => {
		const idx = Number(el.dataset.sectionIndex);
		const cb = form.querySelector(`[name="print-section"][value="${idx}"]`);
		if (cb && !cb.checked) el.remove();
	});

	// Card parts — drop unchecked sections inside every card
	Object.keys(PART_SELECTORS).forEach((key) => {
		const cb = form.querySelector(`[name="print-card-${key}"]`);
		if (cb && !cb.checked) {
			clone.querySelectorAll(PART_SELECTORS[key]).forEach((el) => el.remove());
		}
	});

	// Table columns
	const table = clone.querySelector(".program-table");
	if (table) removeTableColumns(table, selectedCols());

	// One dance card per page. The first visible card only breaks if
	// something (the TOC) precedes it; otherwise it is page 1. Breaks are
	// applied via a class (not inline style) because Paged.js reads break
	// rules from stylesheets, not inline styles — see print-paged.css.
	const tocPresent = !!clone.querySelector('[data-print-view="toc"]');
	clone.querySelectorAll(".print-card").forEach((card, i) => {
		if (i > 0 || tocPresent) card.classList.add("print-card--break");
	});

	return clone;
}

function removeIf(root, selector, condition) {
	if (!condition) return;
	root.querySelectorAll(selector).forEach((el) => el.remove());
}

// ── Segments (one Paged render per orientation) ───────────────

// The table always prints landscape; the TOC + cards follow the user's
// orientation toggle (portrait by default). Paged drives a single @page size
// per render, so each orientation is its own render pass (segment) appended
// to #print-render, in reading order.
function buildSegments() {
	const toc = isChecked('[name="print-toc"]');
	const cards = isChecked('[name="print-cards"]');
	const table = isChecked('[name="print-table"]');
	const landscape = currentOrientation() === "landscape";
	const segments = [];
	if (toc || cards) {
		segments.push({ keep: { toc, cards, table: false }, landscape });
	}
	if (table) {
		segments.push({ keep: { toc: false, cards: false, table: true }, landscape: true });
	}
	return segments;
}

function buildDynamicCss(landscape) {
	const sz = currentPageSize();
	const size = landscape ? `${sz.h}in ${sz.w}in` : `${sz.w}in ${sz.h}in`;
	// --text-scale multiplies every font-size (and the text-anchored column
	// widths) in print-paged.css, so pagination re-flows at the chosen size.
	const textScale = currentTextSize() / DEFAULT_TEXT_SIZE;
	return `@page { size: ${size}; margin: ${sz.margin}in; }\n` +
		`.pagedjs_page { --text-scale: ${textScale}; }\n`;
}

// Paged writes the page-size custom properties to :root AND to per-side
// rules (.pagedjs_right_page / .pagedjs_left_page) in a globally-injected
// stylesheet, so a later segment's render resizes an earlier segment's
// pages. Freeze this segment by setting the size vars INLINE on each
// .pagedjs_page — inline beats the injected per-side rules — plus on the
// container as a fallback. (Margins are symmetric and identical across
// segments, so only the width/height family needs pinning.)
const PIN_W = ["--pagedjs-width", "--pagedjs-width-left", "--pagedjs-width-right", "--pagedjs-pagebox-width"];
const PIN_H = ["--pagedjs-height", "--pagedjs-height-left", "--pagedjs-height-right", "--pagedjs-pagebox-height"];
function pinPageVars(pagesEl, landscape) {
	const sz = currentPageSize();
	const w = `${landscape ? sz.h : sz.w}in`;
	const h = `${landscape ? sz.w : sz.h}in`;
	const apply = (el) => {
		PIN_W.forEach((v) => el.style.setProperty(v, w));
		PIN_H.forEach((v) => el.style.setProperty(v, h));
	};
	apply(pagesEl);
	pagesEl.querySelectorAll(".pagedjs_page").forEach(apply);
}

// ── Render (paginate) with cleanup of the previous run ────────

let currentPreviewers = [];

// Disconnect every Page's ResizeObserver. Each Paged.js Page keeps one that
// calls checkUnderflowAfterResize(); they exist to re-flow content during
// live editing, which this static preview never does. Disconnecting them
// once a render settles is doubly useful: a discarded render's observers
// can't fire against detached nodes (null getAttribute errors) on the next
// render, and the fit-to-width transform can resize the page boxes without
// triggering a spurious underflow re-flow.
function disconnectPageListeners(previewer) {
	if (previewer && previewer.chunker && previewer.chunker.pages) {
		previewer.chunker.pages.forEach((p) => {
			try { if (p && p.removeListeners) p.removeListeners(); } catch (e) { /* ignore */ }
		});
	}
}

// Tear down the previous render(s). Chunker.destroy() does NOT disconnect the
// per-page ResizeObservers, so do that first (a no-op if a render already
// disconnected them once it settled).
function teardownPrevious() {
	currentPreviewers.forEach((previewer) => {
		if (previewer && previewer.chunker) {
			disconnectPageListeners(previewer);
			try { previewer.chunker.destroy(); } catch (e) { /* ignore */ }
		}
	});
	currentPreviewers = [];

	// Remove the <style> elements Paged injected last time so processed
	// @page rules don't accumulate across renders.
	document
		.querySelectorAll("head style[data-pagedjs-inserted-styles]")
		.forEach((el) => el.remove());

	renderTarget.replaceChildren();
}

async function render() {
	if (!window.Paged || !window.Paged.Previewer) return;
	const segments = buildSegments();

	teardownPrevious();
	// With nothing selected the target stays empty; let CSS show a
	// "nothing selected" message instead of the usual rendering state.
	renderTarget.classList.toggle("is-empty", segments.length === 0);
	renderTarget.classList.add("is-rendering");
	renderTarget.setAttribute("aria-busy", "true");

	try {
		for (const seg of segments) {
			const previewer = new window.Paged.Previewer();
			currentPreviewers.push(previewer);
			await previewer.preview(
				buildContent(seg.keep),
				[`${PATH_PREFIX}/static/css/print-paged.css`, { "print-dynamic.css": buildDynamicCss(seg.landscape) }],
				renderTarget
			);
			disconnectPageListeners(previewer);
			// Freeze this segment's page size before the next segment's render
			// rewrites the shared :root page-size variables.
			const containers = renderTarget.querySelectorAll(".pagedjs_pages");
			pinPageVars(containers[containers.length - 1], seg.landscape);
		}
		fitToWidth();
	} finally {
		renderTarget.classList.remove("is-rendering");
		renderTarget.setAttribute("aria-busy", "false");
	}
}

// Scale the rendered pages down to fit a viewport narrower than a page
// (phones, split screens). We use transform:scale rather than `zoom`
// because transform scales the page box and every bit of text by the exact
// same factor on all browsers; WebKit's `zoom` resolves rem and pt units
// differently, so the page-to-text ratio drifted with the viewport width.
// transform leaves the layout box at natural size, so we pair it with a
// negative margin to reclaim the empty space the un-scaled box would hold.
function fitToWidth() {
	const avail = renderTarget.clientWidth;
	// Scale each segment independently — portrait and landscape pages have
	// different widths, so each needs its own fit factor.
	renderTarget.querySelectorAll(".pagedjs_pages").forEach((pages) => {
		pages.style.transform = "";
		pages.style.marginBottom = "";
		const page = pages.querySelector(".pagedjs_page");
		if (!page) return;
		const natural = page.offsetWidth;
		const scale = natural > 0 ? Math.min(1, avail / natural) : 1;
		if (scale < 1) {
			const naturalHeight = pages.offsetHeight;
			pages.style.transform = `scale(${scale.toFixed(4)})`;
			pages.style.marginBottom = `${naturalHeight * (scale - 1)}px`;
		}
	});
}

// Debounce rapid changes, and never run two renders concurrently
// (Paged mutates shared DOM/head state).
let renderTimer = null;
let busy = false;
let queued = false;

// Both actions need a settled, complete render: printing mid-paginate spools
// half a document. The PDF button stays enabled while the background build
// runs — a click just waits for (or restarts) the build — so it's only
// disabled while the preview itself is re-paginating.
function updateActionButtons() {
	if (printBtn) printBtn.disabled = busy;
	if (pdfBtn) pdfBtn.disabled = busy;
}

function scheduleRender() {
	clearTimeout(renderTimer);
	renderTimer = setTimeout(runRender, 120);
}

async function runRender() {
	if (busy) { queued = true; return; }
	busy = true;
	updateActionButtons();
	do {
		queued = false;
		try {
			await render();
		} catch (e) {
			console.error("Paged.js render failed", e);
		}
	} while (queued);
	busy = false;
	// The rendered DOM now reflects the current settings; unblock anything
	// waiting on a settled preview and (re)start the background PDF build.
	renderedGen = pdfGen;
	updateActionButtons();
	notifySettled();
	startPdfJob();
}

function onSettingsChange() {
	// Drop any pre-rendered/in-flight PDF immediately — it's for stale settings.
	invalidatePdf();
	updateSidebarState();
	updateURLParams();
	scheduleRender();
}

// ── Export to PDF (client-side, pre-rendered in the background) ─────
//
// Native print is unreliable on iOS/Safari (WebKit ignores @page margins,
// so Paged.js's pages spill blank pages). The "Open as PDF" button instead
// rasterizes each rendered sheet with html2canvas and assembles a PDF with
// jsPDF whose page size matches the sheet — so it works the same on every
// browser and is a true picture of the preview.
//
// Rasterizing is slow (~1.5s/page), so rather than start on the button press
// we build the PDF in the background the moment a render settles, and keep a
// finished doc ready. Any settings change bumps `pdfGen`, which invalidates
// the ready doc and cancels an in-flight build (it checks the token between
// pages); once the new preview settles we build again. The button then
// saves the ready doc instantly, or — if a build is still running — waits
// for it. The libraries are heavy (~600KB) and loaded lazily on first build.

// Generation token. Bumped on every settings change; a build captures the
// token it started with and bails the moment the live token moves past it.
let pdfGen = 0;
// The generation whose settings the currently-rendered DOM reflects. A build
// may only run when this equals pdfGen (otherwise it'd capture stale pages).
let renderedGen = -1;
// A finished PDF for the current settings: { gen, doc } or null.
let pdfReady = null;
// An in-flight background build: { gen, promise } or null.
let pdfJob = null;
// Resolvers waiting for the preview to settle on the latest settings.
let settleWaiters = [];

// Called when settings change: any ready/in-flight PDF is now stale.
function invalidatePdf() {
	pdfGen++;
	pdfReady = null;
	setPdfStatus("");
	setPdfProgress(0);
	if (pdfBtn) pdfBtn.classList.remove("is-building", "is-ready");
}

// Resolve everyone waiting for a settled preview (called after a render).
function notifySettled() {
	if (busy || renderedGen !== pdfGen) return;
	const waiters = settleWaiters;
	settleWaiters = [];
	waiters.forEach((r) => r());
}

// A promise that resolves once the rendered DOM reflects the latest settings.
function whenSettled() {
	if (!busy && renderedGen === pdfGen) return Promise.resolve();
	return new Promise((res) => settleWaiters.push(res));
}

// The status text drives the sr-only live region (announced to screen
// readers) and the "Open as PDF" button's tooltip — there's no separate
// visible status line; the button itself is the progress indicator.
function setPdfStatus(msg) {
	if (pdfStatus) pdfStatus.textContent = msg || "";
	if (pdfBtn) {
		if (msg) pdfBtn.title = msg;
		else pdfBtn.removeAttribute("title");
	}
}

// Fill the button 0→1 as the background build progresses (see the
// .print-trigger-btn--pdf fill in print.njk).
function setPdfProgress(fraction) {
	if (!pdfBtn) return;
	const f = Math.max(0, Math.min(1, fraction || 0));
	pdfBtn.style.setProperty("--pdf-progress", String(f));
}

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const s = document.createElement("script");
		s.src = src;
		s.onload = () => resolve();
		s.onerror = () => reject(new Error(`Failed to load ${src}`));
		document.head.appendChild(s);
	});
}

let pdfLibsPromise = null;
function loadPdfLibs() {
	if (!pdfLibsPromise) {
		pdfLibsPromise = Promise.all([
			(window.jspdf && window.jspdf.jsPDF) ? null : loadScript(`${PATH_PREFIX}/static/js/jspdf.umd.min.js`),
			window.html2canvas ? null : loadScript(`${PATH_PREFIX}/static/js/html2canvas.min.js`),
		]).catch((err) => {
			// Don't cache the failure — a retry should attempt the load again
			// (the first may have died on a flaky connection).
			pdfLibsPromise = null;
			throw err;
		});
	}
	return pdfLibsPromise;
}

// px → inches at the CSS reference of 96px/in. offsetWidth/Height are layout
// pixels, unaffected by the on-screen fit-to-width transform, so they give
// the sheet's true size whether or not the preview is scaled down.
function sheetInches(el) {
	return { w: el.offsetWidth / 96, h: el.offsetHeight / 96 };
}

// html2canvas oversampling factor. The bitmap is captured at this multiple
// of CSS pixels, and CSS's reference is 96px/in, so the effective raster
// resolution is 96 × PDF_RASTER_SCALE DPI (3 → 288 DPI). Higher means
// crisper print output at the cost of more memory and time per page.
const PDF_RASTER_SCALE = 3;

// Build a PDF from the currently-rendered pages. Returns the finished jsPDF
// doc, or null if there's nothing to render or the build is cancelled
// (`isCancelled()` goes true when the settings move on). `onProgress(msg,
// fraction)` reports progress. The caller guarantees the DOM reflects the
// current settings.
async function buildPdf(isCancelled, onProgress) {
	if (!renderTarget.querySelector(".pagedjs_sheet")) return null;

	// Capture from an off-screen clone rather than the live pages: the user
	// never sees the preview change, and html2canvas renders untransformed
	// pages (an ancestor transform — the fit-to-width scale — would scramble
	// glyph positions). Cloning each .pagedjs_pages keeps the pinned page-size
	// variables, so the clones lay out at the right size.
	const stage = document.createElement("div");
	stage.setAttribute("aria-hidden", "true");
	stage.style.cssText = "position:absolute; left:-100000px; top:0; background:#fff;";
	renderTarget.querySelectorAll(".pagedjs_pages").forEach((pg) => {
		const clone = pg.cloneNode(true);
		clone.style.transform = "none";
		clone.style.marginBottom = "";
		stage.appendChild(clone);
	});
	document.body.appendChild(stage);

	try {
		await loadPdfLibs();
		if (isCancelled()) return null;
		if (!window.jspdf || !window.jspdf.jsPDF || !window.html2canvas) {
			throw new Error("PDF libraries unavailable");
		}
		const JsPDF = window.jspdf.jsPDF;
		const margin = currentPageSize().margin;

		const sheets = Array.from(stage.querySelectorAll(".pagedjs_sheet"));
		const first = sheetInches(sheets[0]);
		const doc = new JsPDF({
			unit: "in",
			format: [first.w, first.h],
			orientation: first.w > first.h ? "landscape" : "portrait",
			compress: true,
		});

		for (let i = 0; i < sheets.length; i++) {
			if (isCancelled()) return null;
			onProgress(`Preparing PDF… ${i + 1}/${sheets.length}`, (i + 1) / sheets.length);
			// Yield so the status text paints before the (blocking) capture.
			await new Promise((r) => setTimeout(r, 0));
			if (isCancelled()) return null;

			const sheet = sheets[i];
			const dim = sheetInches(sheet);
			// Capture the content AREA, not the whole sheet: html2canvas doesn't
			// reproduce Paged's margin-box grid, so it would render the area at
			// full sheet width (no margins). We grab just the content box and
			// place it inside the page margins ourselves.
			const area = sheet.querySelector(".pagedjs_area") || sheet;
			const canvas = await window.html2canvas(area, {
				scale: PDF_RASTER_SCALE,
				backgroundColor: "#ffffff",
				useCORS: true,
				logging: false,
			});
			if (i > 0) {
				doc.addPage([dim.w, dim.h], dim.w > dim.h ? "landscape" : "portrait");
			}
			doc.addImage(
				canvas.toDataURL("image/png"), "PNG",
				margin, margin, dim.w - 2 * margin, dim.h - 2 * margin
			);
			// Free the canvas before the next page.
			canvas.width = canvas.height = 0;
		}
		return doc;
	} finally {
		stage.remove();
	}
}

// Start (or resume) a background build for the current settings, unless one
// is already finished or running for this generation, or the preview isn't
// settled on the current settings yet.
function startPdfJob() {
	if (busy || renderedGen !== pdfGen) return;
	if (pdfReady && pdfReady.gen === pdfGen) return;
	if (pdfJob && pdfJob.gen === pdfGen) return;

	const myGen = pdfGen;
	const isCancelled = () => myGen !== pdfGen;
	if (pdfBtn) { pdfBtn.classList.remove("is-ready"); pdfBtn.classList.add("is-building"); }
	const promise = (async () => {
		try {
			const doc = await buildPdf(isCancelled, (msg, frac) => {
				if (!isCancelled()) { setPdfStatus(msg); setPdfProgress(frac); }
			});
			if (!isCancelled() && doc) {
				pdfReady = { gen: myGen, doc };
				setPdfStatus("PDF ready to download.");
				// Lock the full fill into the solid "ready" CTA. It must NOT
				// un-fill — resetting the bar to empty read like the progress had
				// been undone. Only a settings change (invalidatePdf) clears it.
				setPdfProgress(1);
				if (pdfBtn) { pdfBtn.classList.remove("is-building"); pdfBtn.classList.add("is-ready"); }
			}
			return doc;
		} catch (e) {
			console.error("Background PDF build failed", e);
			return null;
		} finally {
			if (pdfJob && pdfJob.promise === promise) pdfJob = null;
			if (isCancelled()) {
				// The settings advanced mid-build; the next build (kicked off once
				// its preview settles) owns the button's fill from here.
				startPdfJob();
			} else if (!(pdfReady && pdfReady.gen === myGen)) {
				// Finished but produced nothing (empty selection or failure):
				// return to the resting outline state.
				if (pdfBtn) pdfBtn.classList.remove("is-building");
				setPdfProgress(0);
			}
		}
	})();
	pdfJob = { gen: myGen, promise };
}

function savePdf(doc) {
	try {
		// Leaves the button in its "ready" state — the doc stays valid for
		// repeat downloads until the settings change.
		doc.save(pdfFilename());
	} catch (e) {
		console.error("PDF save failed", e);
		setPdfStatus("PDF export failed — please try again.");
	}
}

// Button handler: save the pre-rendered PDF if it's ready, otherwise wait for
// (or start) the background build and save that once it finishes.
async function openPdf() {
	if (pdfReady && pdfReady.gen === pdfGen) { savePdf(pdfReady.doc); return; }

	setPdfStatus("Preparing PDF…");
	await whenSettled();
	// Nothing selected → nothing to export; don't surface a spurious error.
	if (!renderTarget.querySelector(".pagedjs_sheet")) { setPdfStatus(""); return; }
	const myGen = pdfGen;
	startPdfJob();
	if (pdfReady && pdfReady.gen === myGen) { savePdf(pdfReady.doc); return; }
	if (!pdfJob) { setPdfStatus("PDF export failed — please try again."); return; }

	const doc = await pdfJob.promise;
	if (myGen !== pdfGen) return openPdf();  // settings changed mid-build; retry
	if (doc) savePdf(doc);
	else setPdfStatus("PDF export failed — please try again.");
}

function pdfFilename() {
	const name = (document.title || "program").replace(/\s*[—–-]\s*Print\s*$/i, "").trim();
	return `${name || "program"}.pdf`;
}

// ── Wire up ───────────────────────────────────────────────────

if (form && source && renderTarget) {
	// On WebKit native print is broken (blank pages), so hide it and let
	// "Open as PDF" carry the load. We keep its outline (secondary) style even
	// here: the button is the build progress bar, and it turns into a solid
	// accent CTA on its own once the PDF is ready — promoting it to solid up
	// front would make the sweeping fill look like it's fading to disabled.
	if (IS_WEBKIT_PRINT) {
		if (printBtn) printBtn.hidden = true;
	}

	initFromParams();
	updateSidebarState();
	updateURLParams();
	runRender();

	form.addEventListener("change", onSettingsChange);

	// Re-fit the preview to the viewport on resize / orientation change. This
	// only re-scales the already-rendered pages, so it's cheap (no re-paginate).
	let fitTimer = null;
	window.addEventListener("resize", () => {
		clearTimeout(fitTimer);
		fitTimer = setTimeout(fitToWidth, 100);
	});

	// Custom size inputs update live as the user types.
	form.querySelectorAll('[name="print-page-width"], [name="print-page-height"]').forEach((input) => {
		input.addEventListener("input", onSettingsChange);
	});

	// Text-size slider: update the readout live while dragging (cheap), but let
	// the form-level "change" handler re-paginate on release (the drag can pass
	// through several stops — no point rendering each). The A−/A＋ buttons step
	// one stop and re-render immediately.
	const textRange = form.querySelector('[name="print-text-size"]');
	if (textRange) textRange.addEventListener("input", updateTextSizeLabel);
	if (textDecBtn) textDecBtn.addEventListener("click", () => stepTextSize(-1));
	if (textIncBtn) textIncBtn.addEventListener("click", () => stepTextSize(1));

	// Defer window.print() out of the click handler — Safari can hang its
	// print renderer if invoked synchronously from a focused/active button.
	if (printBtn) {
		printBtn.addEventListener("click", () => {
			printBtn.blur();
			setTimeout(() => window.print(), 0);
		});
	}

	if (pdfBtn) {
		pdfBtn.addEventListener("click", () => {
			pdfBtn.blur();
			openPdf();
		});
	}

	// Close vs Back — show Close when opened as a new window/tab.
	const closeBtn = document.getElementById("print-close-btn");
	const backLink = document.getElementById("print-back-link");
	if (closeBtn) closeBtn.hidden = !window.opener;
	if (backLink) backLink.hidden = !!window.opener;
	if (closeBtn) closeBtn.addEventListener("click", () => window.close());
}
