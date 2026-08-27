// frontend/trajectory.ts
import { $, escapeHtml } from "/dom.js";
var dynamicImport = (url) => import(url);
var markdownModule = null;
function formatDuration(milliseconds) {
  if (milliseconds == null) return "\u2014";
  if (milliseconds < 1e3) return `${milliseconds} ms`;
  const seconds = Math.round(milliseconds / 1e3);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function createTrajectoryView(store) {
  let events = [];
  let selectedId = null;
  let previousCursor = null;
  let moreBefore = false;
  let totalEvents = 0;
  let query = "";
  let searchTimer = null;
  const details = /* @__PURE__ */ new Map();
  function renderOverview(overview) {
    const total = Math.max(1, totalEvents);
    $("#trajectoryOverview").innerHTML = `
      <div class="trajectorytabs">
        <span>${formatDuration(overview.durationMs)} duration</span>
        <span>${overview.turns || 0} turns</span>
        <span>${overview.tools || 0} calls</span>
      </div>
      <div class="trajectorybands">
        <i class="inputband" style="width:${Math.max(3, (overview.users || 0) / total * 100)}%"></i>
        <i class="modelband"></i>
        <i class="toolband" style="width:${Math.max(3, (overview.tools || 0) / total * 100)}%"></i>
      </div>
    `;
  }
  function eventHtml(event) {
    return `
      <button
        class="trajectoryevent ${escapeHtml(event.type)} ${selectedId === event.id ? "selected" : ""}"
        data-id="${escapeHtml(event.id)}"
      >
        <span class="trajectorydot"></span>
        <span class="trajectorytag">${escapeHtml(event.type)}</span>
        <b>${escapeHtml(event.label)}</b>
        <span class="trajectorysummary">${escapeHtml(event.summary || "\u2014")}</span>
        <small>T${event.turn}${event.durationMs != null ? ` \xB7 ${formatDuration(event.durationMs)}` : ""}</small>
      </button>
    `;
  }
  function render() {
    $("#trajectoryCount").textContent = events.length === totalEvents ? `${totalEvents} events` : `${events.length} of ${totalEvents} events`;
    $("#trajectoryEvents").innerHTML = `${moreBefore ? '<button class="loadearlier trajectoryload" type="button">Load earlier events</button>' : ""}` + (events.map(eventHtml).join("") || '<div class="trajectoryempty">No events</div>');
  }
  async function renderInspector(event) {
    if (!event) {
      $("#trajectoryInspect").innerHTML = '<div class="trajectoryempty">Select an event</div>';
      return;
    }
    let content = "";
    if (event.text) {
      if (event.type === "user" || event.type === "assistant") {
        markdownModule ??= await dynamicImport("/markdown.js");
        content = `<h3>Content</h3><div class="trajectorymarkdown markdown">${markdownModule.renderMarkdown(event.text)}</div>`;
      } else {
        content = `<h3>${event.type === "result" ? "Result" : "Content"}</h3><pre>${escapeHtml(event.text)}</pre>`;
      }
    }
    const payload = event.args ? `<h3>Payload</h3><pre>${escapeHtml(JSON.stringify(event.args, null, 2))}</pre>` : "";
    const detailsHtml = event.details ? `<h3>Details</h3><pre>${escapeHtml(JSON.stringify(event.details, null, 2))}</pre>` : "";
    const usage = event.usage ? `<h3>Usage</h3><pre>${escapeHtml(JSON.stringify(event.usage, null, 2))}</pre>` : "";
    if (selectedId !== event.id) return;
    $("#trajectoryInspect").innerHTML = `
      <div class="inspecthead">
        <span class="trajectorytag ${escapeHtml(event.type)}">${escapeHtml(event.type)}</span>
        <b>${escapeHtml(event.label)}</b>
      </div>
      <dl>
        <dt>Turn</dt><dd>${event.turn}</dd>
        <dt>Started</dt><dd>${event.at ? new Date(event.at).toLocaleString() : "\u2014"}</dd>
        <dt>Duration</dt><dd>${formatDuration(event.durationMs)}</dd>
        ${event.toolName ? `<dt>Tool</dt><dd>${escapeHtml(event.toolName)}</dd>` : ""}
      </dl>
      ${payload}${content}${detailsHtml}${usage}
    `;
  }
  async function select(id) {
    selectedId = id;
    $("#trajectoryEvents .selected")?.classList.remove("selected");
    $(`#trajectoryEvents [data-id="${CSS.escape(id)}"]`)?.classList.add(
      "selected"
    );
    const cached = details.get(id);
    if (cached) return renderInspector(cached);
    $("#trajectoryInspect").innerHTML = '<div class="trajectoryempty">Loading event details\u2026</div>';
    try {
      const detail = await store.liveTrajectoryEvent(id).load();
      details.set(id, detail);
      await renderInspector(detail);
    } catch (error) {
      if (selectedId === id)
        $("#trajectoryInspect").innerHTML = `<div class="trajectoryempty">${escapeHtml(error?.message || String(error))}</div>`;
    }
  }
  async function load(force = false, before = null) {
    const page = await store.liveTrajectory({ before, limit: 100, query }).load({ force });
    if (before == null) events = [...page.events];
    else {
      const known = new Set(events.map((event) => event.id));
      events = [
        ...page.events.filter((event) => !known.has(event.id)),
        ...events
      ];
    }
    previousCursor = page.previousCursor;
    moreBefore = page.moreBefore;
    totalEvents = page.total;
    renderOverview(page.overview);
    render();
  }
  function search(value) {
    query = value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(true), 150);
  }
  $("#trajectoryEvents").addEventListener("click", (event) => {
    const target = event.target;
    if (target.closest(".trajectoryload")) {
      if (moreBefore && previousCursor != null)
        void load(false, previousCursor);
      return;
    }
    const button = target.closest(".trajectoryevent");
    if (button?.dataset.id) void select(button.dataset.id);
  });
  return { load, render, search };
}
export {
  createTrajectoryView
};
