// frontend/workflows.ts
import { $, $$, escapeHtml as esc } from "/dom.js";
var text = (value) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
var summary = (workflow) => {
  const counts = workflow.counts || {};
  return `${counts.completed || 0}/${Object.keys(workflow.tasks || {}).length} done \xB7 ${counts.running || 0} running \xB7 r${workflow.revision}`;
};
function createWorkflowView(store) {
  let selected = null;
  let taskFilter = "";
  let events = [];
  let watcher = null;
  let mode = "runs";
  const stopWatch = () => {
    watcher?.stop?.();
    watcher = null;
  };
  const renderList = () => {
    const workflows = [...store.workflows.all()].sort(
      (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
    );
    $("#workflowList").innerHTML = workflows.length ? workflows.map((workflow) => `
          <button class="workflowcard ${workflow.id === selected ? "selected" : ""}" data-workflow="${esc(workflow.id)}">
            <header><span class="workflowstatus ${workflow.status}">${esc(workflow.status)}</span><small>${esc(summary(workflow))}</small></header>
            <b>${esc(workflow.title)}</b>
            <small>${esc(new Date(workflow.createdAt).toLocaleString())}</small>
          </button>`).join("") : '<div class="agentempty">NO WORKFLOWS</div>';
    $$("#workflowList [data-workflow]").forEach((button) => {
      button.onclick = () => select(button.dataset.workflow);
    });
  };
  const renderEvents = () => {
    const output = $("#workflowEventLog");
    if (!output) return;
    output.textContent = events.filter((event) => event.type !== "pi.message_update").map((event) => {
      const scope = event.taskId ? `[${event.taskId}]` : "[workflow]";
      return `${event.cursor} ${event.at} ${scope} ${event.type}${event.data === void 0 ? "" : ` ${text(event.data)}`}`;
    }).join("\n");
    output.scrollTop = output.scrollHeight;
  };
  const watch = async () => {
    stopWatch();
    if (!selected) return;
    const page = await store.workflowEvents({
      workflowId: selected,
      taskId: taskFilter || void 0,
      after: 0,
      limit: 1e3
    });
    events = [...page.events].slice(-500);
    renderEvents();
    const iterable = store.watchWorkflowEvents({
      workflowId: selected,
      taskId: taskFilter || void 0,
      after: page.cursor
    });
    watcher = iterable;
    try {
      for await (const event of iterable) {
        if (selected !== event.workflowId) break;
        events.push(event);
        events = events.slice(-500);
        renderEvents();
      }
    } catch (error) {
      events.push({ cursor: 0, at: (/* @__PURE__ */ new Date()).toISOString(), type: "stream.error", data: error.message });
      renderEvents();
    }
  };
  const renderDetail = () => {
    const workflow = store.workflows.get(selected);
    if (!workflow) {
      $("#workflowDetail").innerHTML = '<div class="agentempty">NO WORKFLOW SELECTED</div>';
      return;
    }
    const tasks = Object.values(workflow.tasks || {});
    $("#workflowDetail").innerHTML = `<div class="workflowdetail">
      <div class="workflowhead">
        <div><span class="workflowstatus ${workflow.status}">${esc(workflow.status)}</span><h1>${esc(workflow.title)}</h1><small>${esc(summary(workflow))}</small></div>
        <div class="workflowactions"></div>
      </div>
      <div class="workflowtasks">${tasks.map((task) => `
        <article class="workflowtask">
          <div class="workflowtaskhead"><b>${esc(task.title || task.id)}</b><span class="workflowstatus ${task.status}">${esc(task.status)}</span></div>
          <p>${esc(task.prompt)}</p>
          ${task.progress != null ? `<progress max="1" value="${task.progress}"></progress><small>${esc(task.progressLabel || `${Math.round(task.progress * 100)}%`)}</small>` : ""}
          ${(task.dependsOn || []).length ? `<div class="workflowdeps">AFTER ${esc(task.dependsOn.join(", "))}</div>` : ""}
          ${task.error ? `<pre>${esc(task.error)}</pre>` : ""}
          <div class="workflowactions"></div>
        </article>`).join("")}</div>
      <div class="workflowevents">
        <div class="workfloweventfilters"><b>EVENTS</b><select id="workflowTaskFilter"><option value="">COLLECTIVE</option>${tasks.map((task) => `<option value="${esc(task.id)}" ${task.id === taskFilter ? "selected" : ""}>${esc(task.id)}</option>`).join("")}</select></div>
        <pre id="workflowEventLog"></pre>
      </div>
    </div>`;
    $("#workflowTaskFilter").onchange = (event) => {
      taskFilter = event.target.value;
      void watch();
    };
    renderEvents();
  };
  const select = (id) => {
    selected = id;
    taskFilter = "";
    events = [];
    renderList();
    renderDetail();
    void watch();
  };
  const setMode = (next) => {
    mode = next;
    const workflowMode = mode === "workflows";
    $("#runsMode").classList.toggle("active", !workflowMode);
    $("#workflowsMode").classList.toggle("active", workflowMode);
    $("#agentList").classList.toggle("hidden", workflowMode);
    $("#workflowList").classList.toggle("hidden", !workflowMode);
    $("#agentDetail").classList.toggle("hidden", workflowMode);
    $("#workflowDetail").classList.toggle("hidden", !workflowMode);
    $("#agentInspect").classList.toggle("hidden", workflowMode);
    $("#newAgent").textContent = workflowMode ? "+ WORKFLOW" : "+ NEW";
    if (workflowMode) {
      renderList();
      renderDetail();
    } else stopWatch();
  };
  $("#runsMode").onclick = () => setMode("runs");
  $("#workflowsMode").onclick = () => setMode("workflows");
  store.workflows.subscribe(() => {
    renderList();
    if (mode === "workflows") renderDetail();
  });
  return {
    get mode() {
      return mode;
    },
    setMode,
    select,
    dispose: stopWatch
  };
}
export {
  createWorkflowView
};
