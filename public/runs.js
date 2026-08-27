// frontend/runs.ts
function creatorName(run) {
  return run.creator?.username || "Anonymous";
}
function filterRuns(runs, query) {
  const normalized = query.toLowerCase();
  return runs.filter(
    (run) => !normalized || run.title.toLowerCase().includes(normalized) || run.prompt.toLowerCase().includes(normalized) || creatorName(run).toLowerCase().includes(normalized)
  ).sort(
    (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
  );
}
var RunsController = class {
  constructor(adapter, view) {
    this.adapter = adapter;
    this.view = view;
  }
  adapter;
  view;
  runs = [];
  selectedId = null;
  filter = "";
  drafts = /* @__PURE__ */ new Map();
  async load(force = false) {
    try {
      if (force) await this.adapter.refresh();
      this.update(this.adapter.all());
    } catch (error) {
      this.view.showListError(error, this.runs.length > 0);
    }
  }
  update(runs) {
    this.runs = runs;
    this.render();
  }
  setFilter(value) {
    this.filter = value;
    this.render();
  }
  select(id, { render = true, push = true } = {}) {
    this.selectedId = id;
    if (render) this.render();
    else this.renderDetail();
    if (push) this.adapter.navigate(`/agents/${encodeURIComponent(id)}`);
  }
  clearSelection() {
    this.selectedId = null;
    this.render();
  }
  has(id) {
    return this.runs.some((run) => run.id === id);
  }
  setDraft(id, value) {
    this.drafts.set(id, value);
  }
  draft(id) {
    return this.drafts.get(id) || "";
  }
  render() {
    const filtered = filterRuns(this.runs, this.filter);
    this.view.renderList(filtered, this.selectedId);
    if (filtered.length) this.renderDetail();
  }
  renderDetail() {
    const run = this.runs.find((candidate) => candidate.id === this.selectedId);
    if (run) this.view.renderDetail(run, this.draft(run.id));
  }
  async stop(id) {
    try {
      await this.adapter.stop(id);
    } catch (error) {
      this.adapter.alert(error?.message);
    }
  }
  async compact(id) {
    this.view.setCompactPending?.(true);
    try {
      await this.adapter.compact(id);
    } catch (error) {
      this.view.setCompactPending?.(false);
      this.adapter.alert(error?.message);
    }
  }
  async submitFollowup(id) {
    const prompt = this.draft(id).trim();
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!prompt || run?.status === "running" || run?.status === "compacting")
      return;
    this.drafts.set(id, "");
    this.view.setDraft?.("");
    this.view.setFollowupPending?.(true);
    try {
      await this.adapter.message(id, prompt, this.adapter.attribution());
      this.view.setDraft?.("");
      this.view.scrollTranscriptToEnd?.();
    } catch (error) {
      this.drafts.set(id, prompt);
      this.view.setDraft?.(prompt);
      this.view.setFollowupPending?.(false);
      this.adapter.alert(error?.message);
    }
  }
};
function duration(run) {
  const end = run.endedAt ? new Date(run.endedAt) : /* @__PURE__ */ new Date();
  const start = new Date(run.startedAt || run.createdAt);
  const seconds = Math.max(
    0,
    Math.round((end.getTime() - start.getTime()) / 1e3)
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function createRunsView(adapter) {
  const $ = adapter.query;
  const $$ = adapter.queryAll;
  const esc = adapter.escape;
  const num = (value) => value == null ? "\u2014" : new Intl.NumberFormat().format(value);
  const avatar = (run, size = "small") => {
    const creator = run.creator;
    const initial = esc((creator?.username || "?").slice(0, 1).toUpperCase());
    return creator?.pfp ? `<img class="runavatar ${size}" src="${esc(creator.pfp)}" data-initial="${initial}" alt="">` : `<span class="runavatar ${size} fallback">${initial}</span>`;
  };
  const sourceHtml = (content, path) => `<div class="toolcode"><pre>${String(content || "").split("\n").map((row) => {
    const match = row.match(/^\s*(\d+)\s{2}(.*)$/s);
    const number = match ? match[1] : "";
    const code = match ? match[2] : row;
    return `<span class="codeline"><span class="lineno">${number}</span><code class="hljs">${adapter.highlightLine(code, path)}</code></span>`;
  }).join("")}</pre></div>`;
  const diffHtml = (diff, path = "") => {
    if (!diff) return '<div class="diffempty">No change</div>';
    let oldLine = 0;
    let newLine = 0;
    return `<div class="toolcode diffcode"><pre>${diff.split("\n").map((line) => {
      let cls = "";
      let number = "";
      if (line.startsWith("@@")) {
        cls = "hunk";
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (match) {
          oldLine = +match[1];
          newLine = +match[2];
        }
      } else if (line.startsWith("+++") || line.startsWith("---"))
        cls = "file";
      else if (line.startsWith("+")) {
        cls = "add";
        number = newLine++;
      } else if (line.startsWith("-")) {
        cls = "del";
        number = oldLine++;
      } else {
        number = newLine;
        oldLine++;
        newLine++;
      }
      const prefix = cls === "add" ? "+" : cls === "del" ? "\u2212" : line.slice(0, 1) === " " ? " " : "";
      const code = cls === "hunk" || cls === "file" ? esc(line) : `${prefix}${adapter.highlightLine(line.slice(line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? 1 : 0), path)}`;
      return `<span class="codeline ${cls}"><span class="lineno">${number}</span><code class="hljs">${code}</code></span>`;
    }).join("")}</pre></div>`;
  };
  const diffStats = (diff = "") => {
    let add = 0;
    let del = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    return add || del ? `<span class="diffstat addstat">+${add}</span><span class="diffstat delstat">\u2212${del}</span>` : "";
  };
  const toolLabel = (name = "tool") => ({
    read: "Read",
    write: "Write",
    edit: "Edit",
    bash: "Bash",
    view: "View",
    web_search: "Search"
  })[name] || name.replace(/_/g, " ").replace(/^./, (value) => value.toUpperCase());
  const toolIcon = (name = "tool") => ({
    read: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/><path d="M5 6h6M5 9h4"/></svg>`,
    write: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 2l3 3-9 9H2v-3z"/></svg>`,
    edit: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 2l3 3-9 9H2v-3z"/></svg>`,
    bash: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5l4 3-4 3M8 11h5"/></svg>`,
    view: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>`,
    web_search: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4"/><path d="M10 10l4 4"/></svg>`
  })[name] || `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>`;
  const eventHtml = (event) => {
    if (event.type === "tool") {
      const args = event.args ? JSON.stringify(event.args, null, 2) : "\u2014";
      const artifact = event.artifact;
      const name = event.name || "tool";
      let target = "";
      if (artifact?.path)
        target += `<code class="toolpath">${esc(artifact.path)}</code>`;
      else if (name === "bash" && event.args?.command)
        target += `<code class="commandpreview">${esc(event.args.command.replace(/\s+/g, " ").slice(0, 100))}</code>`;
      if (artifact?.range)
        target += `<span class="toolrange">${esc(artifact.range)}</span>`;
      if (artifact?.count && !artifact?.diff)
        target += `<span class="toolrange">${artifact.count} replacement${artifact.count === 1 ? "" : "s"}</span>`;
      if (artifact?.kind === "diff") target += diffStats(artifact.diff);
      const body = artifact?.kind === "read" ? sourceHtml(artifact.content || "", artifact.path) : artifact?.kind === "diff" ? diffHtml(artifact.diff || "", artifact.path) : `<pre>${esc(args)}</pre>`;
      return `<div class="event toolrow"><details class="toolevent" data-call-id="${esc(event.callId || event.id || "")}"><summary class="tool-${esc(name)}"><i>${toolIcon(name)}</i><span class="toolname">${esc(toolLabel(name))}</span>${target}</summary>${body}</details></div>`;
    }
    if (event.type === "compaction")
      return `<div class="event compactionevent"><span>Context compacted</span>${event.result?.tokensBefore ? `<small>${num(event.result.tokensBefore)} \u2192 ${num(event.result.estimatedTokensAfter || 0)} tokens</small>` : ""}</div>`;
    if (event.type === "message")
      return `<div class="event messageevent"><div class="eventtext markdown">${adapter.renderMarkdown(event.text || "")}</div></div>`;
    if (event.type === "user")
      return `<div class="event followupuser"><div class="followupbubble">${avatar({ creator: event.creator }, "prompt")}<div>${esc(event.text || "")}</div></div></div>`;
    if (event.type === "reasoning")
      return `<div class="event reasoningevent"><div class="thoughttext markdown">${adapter.renderMarkdown(event.text || "")}</div></div>`;
    return `<div class="event ${esc(event.type)}"><div class="eventtext"><span class="eventkind">${event.type === "error" ? "Error" : event.type === "stderr" ? "stderr" : ""}</span><span>${esc(event.text || "")}</span></div></div>`;
  };
  let controller;
  const view = {
    renderList(runs, selectedId) {
      const element = $("#agentList");
      const listScroll = element.scrollTop;
      if (!runs.length) {
        element.innerHTML = '<div class="agentempty">NO MATCHES</div>';
        return;
      }
      element.innerHTML = runs.map(
        (run) => `<button class="agent ${selectedId === run.id ? "selected" : ""}" data-id="${run.id}"><span class="state ${run.status}">${esc(run.status.toUpperCase())}</span><b>${esc(run.title)}</b><small class="creatorline">${avatar(run)}<span>${esc(creatorName(run))} \xB7 ${duration(run)} \xB7 ${run.toolCount || 0} tools</span></small></button>`
      ).join("");
      $$(".agent").forEach(
        (button) => button.onclick = () => controller.select(button.dataset.id)
      );
      element.scrollTop = listScroll;
    },
    renderDetail(run, draft) {
      const oldTranscript = $(".agenttranscript");
      const oldScroll = oldTranscript?.scrollTop || 0;
      const nearBottom = oldTranscript ? oldTranscript.scrollHeight - oldTranscript.scrollTop - oldTranscript.clientHeight < 80 : false;
      const hadFocus = document.activeElement?.id === "followupPrompt";
      const openTools = new Set(
        $$("#agentDetail .toolevent[open]").map((element) => element.dataset.callId).filter(Boolean)
      );
      const usage = run.usage || {};
      const timeline = (run.events || []).length ? (run.events || []).map(eventHtml).join("") : `<div class="event"><div class="eventlabel">LOG</div><pre class="legacylog">${esc(run.output || "\u2014")}</pre></div>`;
      $("#agentDetail").innerHTML = `<div class="agenttranscript"><div class="taskhead"><div class="taskcreator">${avatar(run, "large")}<span><small>CREATED BY</small><b>${esc(creatorName(run))}</b></span></div><h1>${esc(run.title)}</h1><div class="tasksub"><span class="statuspill ${run.status}">${esc(run.status.toUpperCase())}</span><span>bashtv/free</span><span>${duration(run)}</span>${run.status === "running" ? `<button class="stopagent" onclick="stopAgent('${run.id}')">STOP</button>` : ""}</div></div><div class="promptblock">${avatar(run, "prompt")}<div>${esc(run.prompt)}</div></div><div class="timeline">${timeline}</div></div><form class="followupcomposer ${run.status === "running" || run.status === "compacting" ? "working" : ""}" data-run-id="${run.id}"><textarea id="followupPrompt" rows="3" maxlength="20000" placeholder="${run.status === "compacting" ? "Compacting context\u2026" : run.status === "running" ? "Agent is working\u2026" : "Message agent"}" ${run.status === "running" || run.status === "compacting" ? "disabled" : ""}>${esc(draft)}</textarea><div class="composerbar"><div class="composerinfo"><span class="modelstar" aria-hidden="true"></span><span>bashtv/free</span><span class="thinkingmark" aria-hidden="true"></span><span>low</span><span class="contextring" style="--context:${Math.min(100, Math.round((usage.totalTokens || 0) / 2560))}%" title="${num(usage.totalTokens || 0)} / 256K tokens \xB7 ${Math.min(100, Math.round((usage.totalTokens || 0) / 2560))}% context" aria-label="${Math.min(100, Math.round((usage.totalTokens || 0) / 2560))}% context"></span><span class="contextpercent">${Math.min(100, Math.round((usage.totalTokens || 0) / 2560))}%</span><button type="button" class="compactrun" ${run.status === "running" || run.status === "compacting" ? "disabled" : ""}>Compact</button></div>${run.status === "running" ? `<button type="button" class="stopfollow" aria-label="Stop agent"><span></span></button>` : `<button type="submit" class="sendfollow" aria-label="Send message" ${run.status === "compacting" ? "disabled" : ""}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg></button>`}</div></form>`;
      const followup = $("#followupPrompt");
      followup?.addEventListener(
        "input",
        () => controller.setDraft(run.id, followup.value)
      );
      followup?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          controller.submitFollowup(run.id);
        }
      });
      $(".followupcomposer")?.addEventListener("submit", (event) => {
        event.preventDefault();
        controller.submitFollowup(run.id);
      });
      $(".compactrun")?.addEventListener(
        "click",
        () => controller.compact(run.id)
      );
      $(".stopfollow")?.addEventListener(
        "click",
        () => controller.stop(run.id)
      );
      requestAnimationFrame(() => {
        const transcript = $(".agenttranscript");
        if (transcript)
          transcript.scrollTop = nearBottom ? transcript.scrollHeight : oldScroll;
        if (hadFocus) followup?.focus();
      });
      $$("#agentDetail .toolevent").forEach((element) => {
        if (openTools.has(element.dataset.callId)) element.open = true;
      });
      $("#agentMeta").innerHTML = [
        ["CREATOR", creatorName(run)],
        ...run.originChat?.title ? [["CHAT", run.originChat.title]] : [],
        ["RUN", run.id.slice(0, 8)],
        ["CWD", run.cwd],
        ["STARTED", new Date(run.startedAt).toLocaleString()],
        ["DURATION", duration(run)],
        ["TOOLS", run.toolCount || 0],
        ["TOKENS", usage.totalTokens || "\u2014"],
        ["EXIT", run.exitCode ?? "\u2014"]
      ].map(
        ([key, value]) => `<div class="metarow"><span>${key}</span><b>${esc(value)}</b></div>`
      ).join("");
      $("#agentChanges").innerHTML = (run.changes || []).length ? run.changes.map(
        (change) => `<div class="change"><code>${esc(change.status)}</code>${esc(change.path)}</div>`
      ).join("") : '<div class="metarow"><span>NONE</span></div>';
    },
    showListError(error, hasRuns) {
      if (!hasRuns)
        $("#agentList").innerHTML = `<pre>${esc(error.message)}</pre>`;
    },
    setDraft(draft) {
      const input = $("#followupPrompt");
      if (input) input.value = draft;
    },
    setCompactPending(pending) {
      const button = $(".compactrun");
      if (button) {
        button.disabled = pending;
        button.textContent = pending ? "COMPACTING\u2026" : "COMPACT";
      }
    },
    setFollowupPending(pending) {
      const input = $("#followupPrompt");
      if (input) input.disabled = pending;
      const button = $(".sendfollow");
      if (button) button.disabled = pending;
      if (!pending) input?.focus();
    },
    scrollTranscriptToEnd() {
      requestAnimationFrame(() => {
        const transcript = $(".agenttranscript");
        if (transcript) transcript.scrollTop = transcript.scrollHeight;
      });
    }
  };
  controller = new RunsController(adapter, view);
  window.stopAgent = (id) => controller.stop(id);
  $("#agentSearch").oninput = (event) => controller.setFilter(event.target.value);
  return controller;
}
function toggleRunsInspector(query) {
  const inspect = query("#agentInspect");
  const layout = query(".agentlayout");
  if (!inspect || !layout) return;
  inspect.classList.toggle("collapsed");
  layout.classList.toggle("inspect-collapsed");
}
export {
  RunsController,
  createRunsView,
  creatorName,
  filterRuns,
  toggleRunsInspector
};
