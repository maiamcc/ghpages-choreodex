// Module-level (non-reactive) state — keep Pagefind module out of Alpine's reactive Proxy
let pagefindModule = null;
let choreoTimer = null;

document.addEventListener("alpine:init", () => {
	Alpine.data("danceFilter", () => ({
		typeFilter: "all",
		titleQuery: "",
		authorQuery: "",
		formationFilter: "",
		difficultyFilter: "",
		choreoQuery: "",
		choreoSlugs: null,
		choreoLoading: false,
		choreoUnavailable: false,
		visibleCount: 0,
		totalCount: 0,
		allExpanded: false,
		showTypePills: true,

		init() {
			this.totalCount = document.querySelectorAll(".dance-item").length;
			this.$watch("typeFilter", () => this.applyFilters());
			this.$watch("titleQuery", () => this.applyFilters());
			this.$watch("authorQuery", () => this.applyFilters());
			this.$watch("formationFilter", () => this.applyFilters());
			this.$watch("difficultyFilter", () => this.applyFilters());
			this.$watch("choreoQuery", () => {
				clearTimeout(choreoTimer);
				choreoTimer = setTimeout(() => this.updateChoreo(), 400);
			});
			this.applyFilters();
		},

		applyFilters() {
			let count = 0;
			document.querySelectorAll(".dance-item").forEach((el) => {
				const show = this.itemVisible(el);
				el.hidden = !show;
				if (show) count++;
			});
			this.visibleCount = count;
		},

		toggleAllDescriptions() {
			this.allExpanded = !this.allExpanded;
			window.dispatchEvent(new CustomEvent("dance-set-expanded", { detail: this.allExpanded }));
		},

		itemVisible(el) {
			if (this.typeFilter !== "all" && el.dataset.danceType !== this.typeFilter) return false;
			if (this.formationFilter && el.dataset.formation !== this.formationFilter) return false;
			if (this.difficultyFilter && el.dataset.difficulty !== this.difficultyFilter) return false;
			if (this.titleQuery) {
				const title = el.querySelector(".dance-link")?.textContent.toLowerCase() ?? "";
				if (!title.includes(this.titleQuery.toLowerCase())) return false;
			}
			if (this.authorQuery) {
				const who = `${el.dataset.author ?? ""} ${el.dataset.interpretedBy ?? ""}`.toLowerCase();
				if (!who.includes(this.authorQuery.toLowerCase())) return false;
			}
			if (this.choreoSlugs !== null && !this.choreoSlugs.has(el.dataset.slug)) return false;
			return true;
		},

		async updateChoreo() {
			const q = this.choreoQuery.trim();
			if (!q) {
				this.choreoSlugs = null;
				this.applyFilters();
				return;
			}
			if (this.choreoUnavailable) return;
			this.choreoLoading = true;
			try {
				if (!pagefindModule) {
					const prefix = (window.PATH_PREFIX || "/").replace(/\/$/, "");
					pagefindModule = await import(`${prefix}/pagefind/pagefind.js`);
				}
				const { results } = await pagefindModule.search(q);
				const data = await Promise.all(results.map((r) => r.data()));
				this.choreoSlugs = new Set(
					data.map((d) => d.url.match(/\/dances\/([^/]+)\//)?.[1]).filter(Boolean),
				);
			} catch {
				this.choreoUnavailable = true;
				this.choreoSlugs = null;
			} finally {
				this.choreoLoading = false;
			}
			this.applyFilters();
		},
	}));
});
