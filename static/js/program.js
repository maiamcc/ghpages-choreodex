// ----------------------------------------------------------------
// View toggling — web component so connectedCallback re-fires after
// Eleventy dev server DOM morphing (which reconnects custom elements).
// ----------------------------------------------------------------
const DEFAULT_VIEWS = ["program", "cards"];

function getActiveViewsFromURL() {
	const param = new URLSearchParams(window.location.search).get("views");
	if (param === null) return DEFAULT_VIEWS;
	return param ? param.split(",") : [];
}

function saveViewPrefs(activeViews) {
	const url = new URL(window.location.href);
	const isDefault =
		activeViews.length === DEFAULT_VIEWS.length &&
		DEFAULT_VIEWS.every((v) => activeViews.includes(v));
	if (isDefault) {
		url.searchParams.delete("views");
	} else {
		url.searchParams.set("views", activeViews.join(","));
	}
	history.replaceState(null, "", url);
	updateDanceLinks(activeViews, isDefault);
}

function updateDanceLinks(activeViews, isDefault) {
	if (isDefault === undefined) {
		isDefault =
			activeViews.length === DEFAULT_VIEWS.length &&
			DEFAULT_VIEWS.every((v) => activeViews.includes(v));
	}
	document.querySelectorAll('a[href*="from_program"]').forEach((a) => {
		const url = new URL(a.href, window.location.href);
		if (isDefault) {
			url.searchParams.delete("from_views");
		} else {
			url.searchParams.set("from_views", activeViews.join(","));
		}
		a.href = url.toString();
	});
}

class ProgramViewToggle extends HTMLElement {
	connectedCallback() {
		this._applyState();
		if (!this._clickHandler) {
			this._clickHandler = (e) => {
				const btn = e.target.closest(".program-view-btn");
				if (!btn) return;
				const view = btn.dataset.view;
				const panel = document.querySelector(`.program-view--${view}`);
				const isActive = btn.classList.contains("active");
				btn.classList.toggle("active", !isActive);
				btn.setAttribute("aria-pressed", String(!isActive));
				if (panel) panel.hidden = isActive;
				const nowActive = Array.from(this.querySelectorAll(".program-view-btn"))
					.filter((b) => b.classList.contains("active"))
					.map((b) => b.dataset.view);
				saveViewPrefs(nowActive);
			};
			this.addEventListener("click", this._clickHandler);
		}
	}

	_applyState() {
		const activeViews = getActiveViewsFromURL();
		this.querySelectorAll(".program-view-btn").forEach((btn) => {
			const view = btn.dataset.view;
			const panel = document.querySelector(`.program-view--${view}`);
			const shouldBeActive = activeViews.includes(view);
			btn.classList.toggle("active", shouldBeActive);
			btn.setAttribute("aria-pressed", String(shouldBeActive));
			if (panel) panel.hidden = !shouldBeActive;
		});
		updateDanceLinks(activeViews);
	}
}

customElements.define("program-view-toggle", ProgramViewToggle);

// ----------------------------------------------------------------
// Shared helpers for column-filtered table export
// ----------------------------------------------------------------
const _EXPORT_COLUMN_COUNT = 9;
const _EXPORT_ALL_COLS = Array.from({ length: _EXPORT_COLUMN_COUNT }, (_, i) => i);
const _EXPORT_LS_KEY = "choreodex:copy-col-selection";

function loadColSelection() {
	try {
		const raw = localStorage.getItem(_EXPORT_LS_KEY);
		if (!raw) return new Set(_EXPORT_ALL_COLS);
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set(_EXPORT_ALL_COLS);
		return new Set(parsed.filter((n) => Number.isInteger(n) && n >= 0 && n < _EXPORT_COLUMN_COUNT));
	} catch {
		return new Set(_EXPORT_ALL_COLS);
	}
}

function saveColSelection(selectedSet) {
	try {
		localStorage.setItem(_EXPORT_LS_KEY, JSON.stringify([...selectedSet]));
	} catch {
		// ignore — storage quota or private mode
	}
}

function buildFilteredTableClone(selectedCols) {
	const table = document.querySelector(".program-table");
	if (!table) return null;
	const clone = table.cloneNode(true);

	const colsToRemove = _EXPORT_ALL_COLS.filter((i) => !selectedCols.has(i));
	colsToRemove.slice().reverse().forEach((colIdx) => {
		const cols = clone.querySelectorAll("colgroup col");
		if (cols[colIdx]) cols[colIdx].remove();

		const headerRow = clone.querySelector("thead tr");
		if (headerRow) {
			const th = headerRow.querySelectorAll("th")[colIdx];
			if (th) th.remove();
		}

		clone.querySelectorAll("tbody tr").forEach((tr) => {
			const cells = tr.querySelectorAll("td");
			if (cells.length === 1 && cells[0].hasAttribute("colspan")) {
				cells[0].setAttribute("colspan", selectedCols.size);
				return;
			}
			if (cells[colIdx]) cells[colIdx].remove();
		});
	});

	return clone;
}

function applyEmailStyles(clone) {
	Object.assign(clone.style, {
		borderCollapse: "collapse",
		fontFamily: "sans-serif",
		fontSize: "14px",
		width: "100%",
	});

	clone.querySelectorAll("th, td").forEach((cell) => {
		Object.assign(cell.style, {
			padding: "6px 10px",
			border: "1px solid #d0d0d0",
			textAlign: "left",
			verticalAlign: "top",
		});
	});

	clone.querySelectorAll("th").forEach((th) => {
		Object.assign(th.style, {
			fontWeight: "700",
			backgroundColor: "#f5f5f5",
			textTransform: "uppercase",
			fontSize: "11px",
			color: "#666666",
			letterSpacing: "0.06em",
			whiteSpace: "nowrap",
		});
	});

	clone.querySelectorAll(".program-table-section-row td").forEach((td) => {
		Object.assign(td.style, {
			fontWeight: "700",
			backgroundColor: "#f0f0f0",
			borderTop: "2px solid #d0d0d0",
		});
	});

	clone.querySelectorAll(".program-table-missing td").forEach((td) => {
		Object.assign(td.style, {
			color: "#999999",
			fontStyle: "italic",
		});
	});

	clone.querySelectorAll("a").forEach((a) => {
		Object.assign(a.style, {
			color: "#3b6fce",
			textDecoration: "none",
		});
	});
}

function escapeCSVField(value) {
	if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
		return '"' + value.replace(/"/g, '""') + '"';
	}
	return value;
}

function downloadCSV(tableClone) {
	const rows = [];
	const headerCells = tableClone.querySelectorAll("thead tr th");
	if (headerCells.length) {
		rows.push(Array.from(headerCells).map((th) => th.textContent.trim()));
	}
	tableClone.querySelectorAll("tbody tr").forEach((tr) => {
		const cells = tr.querySelectorAll("td");
		if (cells.length === 1 && cells[0].getAttribute("colspan")) {
			const label = cells[0].textContent.trim();
			rows.push([label, ...Array(headerCells.length - 1).fill("")]);
			return;
		}
		rows.push(Array.from(cells).map((td) => td.textContent.trim()));
	});

	const csv = rows.map((row) => row.map(escapeCSVField).join(",")).join("\n");

	const pageTitle = document.title || "program";
	const slug = pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const filename = `${slug || "program"}.csv`;

	const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------------------------------------------------------
// TableExportActions — wires column-select popover shared between
// the Copy and Download CSV split buttons.
// Custom element so connectedCallback re-fires after Eleventy's
// dev-server DOM morphing (same pattern as ProgramViewToggle).
// ----------------------------------------------------------------
class TableExportActions extends HTMLElement {
	connectedCallback() {
		this._copyMainBtn = this.querySelector("#copy-table-btn");
		this._copyCaretBtn = this.querySelector("#copy-caret-btn");
		this._csvMainBtn = this.querySelector("#download-csv-btn");
		this._csvCaretBtn = this.querySelector("#csv-caret-btn");
		this._popover = this.querySelector("#col-select-popover");
		this._copyBtn = this.querySelector("#col-select-copy-btn");
		this._csvBtn = this.querySelector("#col-select-csv-btn");
		this._checks = this._popover
			? Array.from(this._popover.querySelectorAll(".col-select-check"))
			: [];
		this._lastCaretBtn = null;
		this._copyResetTimer = null;

		this._initCheckboxes();
		this._wireMainButtons();
		this._wireCarets();
		this._wirePopoverActions();
	}

	_initCheckboxes() {
		const stored = loadColSelection();
		this._checks.forEach((cb) => {
			cb.checked = stored.has(Number(cb.dataset.colIndex));
			cb.addEventListener("change", () => {
				saveColSelection(this._checkedSet());
				this._updateActionBtnStates();
			});
		});
		this._updateActionBtnStates();
	}

	_checkedSet() {
		return new Set(this._checks.filter((c) => c.checked).map((c) => Number(c.dataset.colIndex)));
	}

	_updateActionBtnStates() {
		const anyChecked = this._checks.some((c) => c.checked);
		if (this._copyBtn) this._copyBtn.disabled = !anyChecked;
		if (this._csvBtn) this._csvBtn.disabled = !anyChecked;
	}

	_wireMainButtons() {
		if (this._copyMainBtn) {
			const orig = this._copyMainBtn.textContent;
			this._copyMainBtn.addEventListener("click", async () => {
				const clone = buildFilteredTableClone(loadColSelection());
				if (!clone) return;
				applyEmailStyles(clone);
				await this._copyHTML(clone.outerHTML, this._copyMainBtn, orig);
			});
		}

		if (this._csvMainBtn) {
			this._csvMainBtn.addEventListener("click", () => {
				const clone = buildFilteredTableClone(loadColSelection());
				if (!clone) return;
				downloadCSV(clone);
			});
		}
	}

	_wireCarets() {
		if (!this._popover) return;

		[this._copyCaretBtn, this._csvCaretBtn].forEach((btn) => {
			if (btn) btn.addEventListener("click", () => { this._lastCaretBtn = btn; });
		});

		this._popover.addEventListener("toggle", (e) => {
			if (e.newState === "open") {
				const anchor = this._lastCaretBtn;
				if (anchor) {
					const rect = anchor.getBoundingClientRect();
					const scrollTop = window.scrollY || document.documentElement.scrollTop;
					const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
					this._popover.style.top = `${rect.bottom + scrollTop + 6}px`;
					this._popover.style.left = `${rect.left + scrollLeft}px`;
					anchor.setAttribute("aria-expanded", "true");
				}
				const isCopy = anchor === this._copyCaretBtn;
				if (this._copyBtn) this._copyBtn.hidden = !isCopy;
				if (this._csvBtn) this._csvBtn.hidden = isCopy;
				const firstCheck = this._popover.querySelector(".col-select-check");
				if (firstCheck) firstCheck.focus();
			} else {
				[this._copyCaretBtn, this._csvCaretBtn].forEach((btn) => {
					if (btn) btn.setAttribute("aria-expanded", "false");
				});
				if (this._lastCaretBtn) this._lastCaretBtn.focus();
			}
		});
	}

	_wirePopoverActions() {
		if (this._copyBtn) {
			const orig = this._copyBtn.textContent;
			this._copyBtn.addEventListener("click", async () => {
				const selected = this._checkedSet();
				if (selected.size === 0) return;
				const clone = buildFilteredTableClone(selected);
				if (!clone) return;
				applyEmailStyles(clone);
				await this._copyHTML(clone.outerHTML, this._copyBtn, orig);
			});
		}

		if (this._csvBtn) {
			const orig = this._csvBtn.textContent;
			let csvFeedbackTimer = null;
			this._csvBtn.addEventListener("click", () => {
				const selected = this._checkedSet();
				if (selected.size === 0) return;
				const clone = buildFilteredTableClone(selected);
				if (!clone) return;
				downloadCSV(clone);
				if (csvFeedbackTimer !== null) clearTimeout(csvFeedbackTimer);
				this._csvBtn.textContent = "Downloading…";
				csvFeedbackTimer = setTimeout(() => {
					this._csvBtn.textContent = orig;
					csvFeedbackTimer = null;
				}, 2000);
			});
		}
	}

	async _copyHTML(html, feedbackTarget, originalText) {
		if (this._copyResetTimer !== null) {
			clearTimeout(this._copyResetTimer);
			this._copyResetTimer = null;
		}
		try {
			const blob = new Blob([html], { type: "text/html" });
			const item = new ClipboardItem({ "text/html": blob });
			await navigator.clipboard.write([item]);
			feedbackTarget.textContent = "Copied!";
			this._copyResetTimer = setTimeout(() => {
				feedbackTarget.textContent = originalText;
				this._copyResetTimer = null;
			}, 2000);
		} catch {
			feedbackTarget.textContent = "Copy failed";
			this._copyResetTimer = setTimeout(() => {
				feedbackTarget.textContent = originalText;
				this._copyResetTimer = null;
			}, 2000);
		}
	}
}

customElements.define("table-export-actions", TableExportActions);

// ----------------------------------------------------------------
// Hijack Cmd/Ctrl+P to open the print preview page instead of the
// browser's print dialog (which can't see the customization options).
// ----------------------------------------------------------------
document.addEventListener("keydown", (e) => {
	if (e.key.toLowerCase() !== "p" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
	const printLink = document.querySelector("a.print-link");
	if (!printLink) return;
	e.preventDefault();
	printLink.click();
});
