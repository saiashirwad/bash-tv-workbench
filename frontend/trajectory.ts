// @ts-expect-error browser deployment module
import { renderMarkdown } from "/markdown.js";
// @ts-expect-error browser deployment module
import { $, $$, escapeHtml } from "/dom.js";

function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;

  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function summarize(event) {
  const text =
    event.type === "tool"
      ? JSON.stringify(event.args || {})
      : String(event.text || "");
  return text.replace(/\s+/g, " ").slice(0, event.type === "tool" ? 180 : 220);
}

function conversationalContent(event) {
  if (event.type === "user" || event.type === "assistant") {
    return `<div class="trajectorymarkdown markdown">${renderMarkdown(event.text)}</div>`;
  }
  return `<pre>${escapeHtml(event.text)}</pre>`;
}

/** Owns trajectory loading, filtering, selection, and inspection. */
export function createTrajectoryView(store: any) {
  let events: any[] = [];
  let selectedId = null;

  function renderInspector() {
    const event = events.find((item) => item.id === selectedId);
    if (!event) {
      $("#trajectoryInspect").innerHTML =
        '<div class="trajectoryempty">Select an event</div>';
      return;
    }

    const payload = event.args
      ? `<h3>Payload</h3><pre>${escapeHtml(JSON.stringify(event.args, null, 2))}</pre>`
      : "";
    const content = event.text
      ? `<h3>${event.type === "result" ? "Result" : "Content"}</h3>${conversationalContent(event)}`
      : "";
    const usage = event.usage
      ? `<h3>Usage</h3><pre>${escapeHtml(JSON.stringify(event.usage, null, 2))}</pre>`
      : "";

    $("#trajectoryInspect").innerHTML = `
      <div class="inspecthead">
        <span class="trajectorytag ${event.type}">${escapeHtml(event.type)}</span>
        <b>${escapeHtml(event.label)}</b>
      </div>
      <dl>
        <dt>Turn</dt><dd>${event.turn}</dd>
        <dt>Started</dt><dd>${event.at ? new Date(event.at).toLocaleString() : "—"}</dd>
        <dt>Duration</dt><dd>${formatDuration(event.durationMs)}</dd>
        ${event.toolName ? `<dt>Tool</dt><dd>${escapeHtml(event.toolName)}</dd>` : ""}
      </dl>
      ${payload}${content}${usage}
    `;
  }

  function render() {
    const query = $("#trajectorySearch")?.value.trim().toLowerCase() || "";
    const visible = events.filter((event) => {
      const searchable = `${event.type} ${event.label} ${summarize(event)}`;
      return !query || searchable.toLowerCase().includes(query);
    });

    $("#trajectoryCount").textContent = `${visible.length} events`;
    $("#trajectoryEvents").innerHTML =
      visible
        .map(
          (event) => `
            <button
              class="trajectoryevent ${event.type} ${selectedId === event.id ? "selected" : ""}"
              data-id="${escapeHtml(event.id)}"
            >
              <span class="trajectorydot"></span>
              <span class="trajectorytag">${escapeHtml(event.type)}</span>
              <b>${escapeHtml(event.label)}</b>
              <span class="trajectorysummary">${escapeHtml(summarize(event) || "—")}</span>
              <small>T${event.turn}${event.durationMs != null ? ` · ${formatDuration(event.durationMs)}` : ""}</small>
            </button>
          `,
        )
        .join("") || '<div class="trajectoryempty">No events</div>';

    $$(".trajectoryevent").forEach((button) => {
      button.onclick = () => {
        selectedId = button.dataset.id;
        render();
        renderInspector();
      };
    });
  }

  function renderOverview(trajectory) {
    const tools = events.filter((event) => event.type === "tool").length;
    const users = events.filter((event) => event.type === "user").length;
    const total = Math.max(1, events.length);

    $("#trajectoryOverview").innerHTML = `
      <div class="trajectorytabs">
        <span>${formatDuration(trajectory.durationMs)} duration</span>
        <span>${trajectory.turns || 0} turns</span>
        <span>${tools} calls</span>
      </div>
      <div class="trajectorybands">
        <i class="inputband" style="width:${Math.max(3, (users / total) * 100)}%"></i>
        <i class="modelband"></i>
        <i class="toolband" style="width:${Math.max(3, (tools / total) * 100)}%"></i>
      </div>
    `;
  }

  async function load(force = false) {
    const data = await store.liveSession({ trajectory: true }).load({ force });
    const trajectory = data?.trajectory || { events: [] };
    events = trajectory.events;
    renderOverview(trajectory);
    render();
  }

  return { load, render };
}
