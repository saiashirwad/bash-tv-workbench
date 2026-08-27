// frontend/app.ts
import { browserStore } from "/workbench-store.js";
import { ensureWorkbenchSession } from "/auth.js";
import { $, $$, escapeHtml } from "/dom.js";
import { registerWorkbenchWebMcp } from "/webmcp.js";
import { LiveChatController, createLiveChatDomView } from "/live-chat.js";
import { createRunsView, toggleRunsInspector } from "/runs.js";
import { createGitController } from "/git.js";
import {
  FilesController,
  createFilesDomView,
  fileRoute,
  filesEditorText,
  openFilesEditor
} from "/files.js";
import page from "/page.mjs";
var markdownModule = null;
var dynamicImport = (url) => import(url);
var renderMarkdown = (text) => markdownModule ? markdownModule.renderMarkdown(text) : escapeHtml(text).replace(/\n/g, "<br>");
var highlightLine = (text, language) => markdownModule ? markdownModule.highlightLine(text, language) : escapeHtml(text);
var workbench = browserStore();
var workflowView = { mode: "agents" };
var trajectoryView = null;
var ensureWorkflowView = async () => workflowView = (await dynamicImport("/workflows.js")).createWorkflowView(
  workbench
);
var ensureTrajectoryView = async () => trajectoryView ??= (await dynamicImport("/trajectory.js")).createTrajectoryView(workbench);
var projects = [];
var liveMode = "chat";
var resolveCollectionsReady;
var collectionsReady = new Promise(
  (resolve) => resolveCollectionsReady = resolve
);
var paletteMatches = [];
var paletteIndex = 0;
var paletteRequest = 0;
var paletteTimer = null;
var paletteReturnFocus = null;
var enc = (s) => encodeURIComponent(s);
function routeFor(page2) {
  if (page2 === "agents")
    return runs.selectedId ? `/agents/${enc(runs.selectedId)}` : "/agents";
  if (page2 === "files") return filesController.route();
  if (page2 === "git") return gitController.routeFor();
  return liveMode === "trajectory" ? "/live?tab=trajectory" : "/live";
}
function notifyRoute() {
  if (window.parent === window) return;
  window.parent.postMessage(
    {
      type: "bash-route",
      path: `${location.pathname}${location.search}${location.hash}`
    },
    origin || "*"
  );
}
function navigate(url, replace = false) {
  if (replace) page.replace(url);
  else page(url);
  notifyRoute();
}
function showPage(page2, push = false) {
  $$("nav button[data-page]").forEach(
    (x) => x.classList.toggle("active", x.dataset.page === page2)
  );
  $$(".page").forEach((x) => x.classList.toggle("hidden", x.id !== page2));
  if (page2 !== "session") liveChat.stop();
  if (push) navigate(routeFor(page2));
}
var esc = escapeHtml;
var errorMessage = (error) => {
  const value = error?.message || error?.error?.message || error?.error;
  if (typeof value === "string" && value !== "[object Object]") return value;
  if (value != null) return JSON.stringify(value);
  if (error && typeof error === "object") {
    const serialized = JSON.stringify(error);
    return serialized === "{}" ? "Mutation failed" : serialized;
  }
  return String(error);
};
var gitController = createGitController({
  query: $,
  queryAll: $$,
  projects: () => projects,
  load: (project, commit, force) => workbench.gitInfo(project, commit).load({ force }),
  setProject: (project) => {
    void filesController.routeProject(project);
  },
  navigate,
  escape: esc,
  schedule: (callback) => requestAnimationFrame(callback),
  errorMessage
});
function num(n) {
  return n == null ? "\u2014" : new Intl.NumberFormat().format(n);
}
function metric(label, value) {
  return `<div class="metric"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}
function identityHtml(user) {
  const name = user?.username || "Bash.tv", initial = esc(name.slice(0, 1).toUpperCase()), picture = user?.pfp ? `<img class="identityavatar" src="${esc(user.pfp)}" data-initial="${initial}" alt="">` : `<span class="identityavatar fallback">${initial}</span>`;
  return `${picture}<span>${esc(name)}</span>`;
}
function setComposerIdentity(user) {
  const name = user?.username || "Bash.tv", initial = name.slice(0, 1).toUpperCase(), el = $("#composerAvatar");
  if (user?.pfp) {
    const img = document.createElement("img");
    img.id = "composerAvatar";
    img.className = "composeravatar";
    img.src = user.pfp;
    img.dataset.initial = initial;
    img.alt = "";
    el.replaceWith(img);
  } else {
    el.className = "composeravatar fallback";
    el.textContent = initial;
  }
}
addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("runavatar") && !img.classList.contains("identityavatar") && !img.classList.contains("composeravatar") && !img.classList.contains("sessionavatar"))
      return;
    const span = document.createElement("span");
    span.id = img.id;
    span.className = img.className + " fallback";
    span.textContent = img.dataset.initial || "?";
    img.replaceWith(span);
  },
  true
);
var runs = createRunsView({
  query: $,
  queryAll: $$,
  all: () => workbench.runs.all(),
  refresh: () => workbench.engine.refresh(),
  get: (id, force = false) => workbench.getRun(id).load({ force }),
  events: (id, input) => workbench.runEventPage(id, input),
  stop: (id) => workbench.stopRun(id),
  compact: (id) => workbench.compactRun(id),
  message: (id, prompt, attribution) => workbench.messageRun(id, prompt, attribution),
  attribution: () => ({
    creator: window.bash?.user || null,
    originChat: window.bash?.chat || null
  }),
  navigate,
  escape: esc,
  renderMarkdown,
  highlightLine,
  alert: (message) => alert(message)
});
function sessionAuthor(m) {
  if (m.author?.username) return m.author;
  if (m.role === "user" && window.bash?.user) return window.bash.user;
  return null;
}
function sessionAvatar(m) {
  const user = sessionAuthor(m), name = user?.username || "User", initial = esc(name.slice(0, 1).toUpperCase());
  return user?.pfp ? `<img class="sessionavatar" src="${esc(user.pfp)}" data-initial="${initial}" alt="">` : `<span class="sessionavatar fallback">${initial}</span>`;
}
function timelineTitle(m, i) {
  const author = m.role === "assistant" ? "Assistant" : sessionAuthor(m)?.username || "User", text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 110), time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  }) : "";
  return `${i + 1}. ${author}${time ? " \xB7 " + time : ""}${text ? " \u2014 " + text : ""}`;
}
function timelinePreview(m, i) {
  const user = sessionAuthor(m), name = user?.username || "User", initial = esc(name.slice(0, 1).toUpperCase()), image = user?.pfp ? `<img class="timelineavatar" src="${esc(user.pfp)}" data-initial="${initial}" alt="">` : `<span class="timelineavatar fallback">${initial}</span>`, time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  }) : "", text = String(m.text || "").replace(/\[image:\s*[^\]]*?original:\s*~\/uploads\/[^\]]+\]/gi, "").trim(), images = (m.images || []).map(
    (file) => `<a href="/api/session-image?name=${encodeURIComponent(file)}" target="_blank" rel="noopener" title="${esc(file)}"><img src="/api/session-image?name=${encodeURIComponent(file)}" alt="${esc(file)}" loading="lazy"></a>`
  ).join("");
  return `<span class="timelinepreview"><span class="timelinepreviewhead">${image}<span class="timelineby"><b>${esc(name)}</b><small>${i + 1}${time ? ` \xB7 ${esc(time)}` : ""}</small></span></span><span class="timelineexcerpt">${esc(text || "Empty message")}</span>${images ? `<span class="timelineimages">${images}</span>` : ""}</span>`;
}
function sessionMessageHtml(m, i) {
  return `<article id="session-message-${i}" class="message ${m.role}" data-index="${i}"><div class="messageauthor">${m.role === "user" ? sessionAvatar(m) : '<span class="assistantmark">//</span>'}<span><b>${esc(m.role === "assistant" ? "Assistant" : sessionAuthor(m)?.username || "User")}</b>${m.timestamp ? `<time>${new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>` : ""}</span></div><div class="body ${m.role === "assistant" ? "markdown" : ""}">${m.role === "assistant" ? renderMarkdown(m.text || "") : esc(m.text)}</div></article>`;
}
function timelineButton(m, i) {
  return `<button class="timelinedot user" data-index="${i}" aria-label="${esc(timelineTitle(m, i))}">${timelinePreview(m, i)}</button>`;
}
function bindTimelineButton(button) {
  button.onclick = () => document.querySelector(`#session-message-${button.dataset.index}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function applySession(s) {
  if (!s) return;
  $("#live").textContent = s.active ? "LIVE" : "IDLE";
  $("#live").classList.toggle("live", s.active);
  const u = s.usage || {};
  $("#metrics").innerHTML = [
    metric("Model", s.model),
    metric("Context tokens", num(u.totalTokens || u.input)),
    metric("Output tokens", num(u.output)),
    metric("Session records", num(s.counts.records)),
    metric("Session file", Math.round(s.bytes / 1024) + " KiB")
  ].join("");
  $("#tools").innerHTML = Object.entries(s.counts.tools || {}).sort((a, b) => b[1] - a[1]).map(
    ([k, v]) => `<div class="tool"><code>${esc(k)}</code><b>${String(v)}</b></div>`
  ).join("");
  $("#runtime").textContent = JSON.stringify(
    {
      sessionId: s.id,
      cwd: s.cwd,
      thinking: s.thinking,
      lastActivity: s.lastActivityAt,
      process: s.process
    },
    null,
    2
  );
}
var liveChat = new LiveChatController(
  {
    load: async (force) => {
      const [session, page2] = await Promise.all([
        workbench.liveSession({ messages: false }).load({ force }),
        workbench.liveSessionPage(null, 100)
      ]);
      return {
        ...session,
        messages: page2.messages,
        cursor: page2.nextCursor
      };
    },
    page: (cursor, limit) => workbench.liveSessionPage(cursor, limit)
  },
  createLiveChatDomView({
    conversation: $("#conversation"),
    timeline: $("#sessionTimeline"),
    renderMessage: sessionMessageHtml,
    renderTimeline: timelineButton,
    hasTimeline: (message) => message.role === "user",
    bindTimeline: bindTimelineButton,
    setCompleted: (completed) => {
      $("#live").textContent = completed ? "IDLE" : "LIVE";
      $("#live").classList.toggle("live", !completed);
    },
    showError: (error, hasMessages) => {
      if (!hasMessages) $("#conversation").textContent = errorMessage(error);
    }
  }),
  applySession
);
var loadSession = (force = false) => liveChat.load(force);
var filesView = createFilesDomView({
  query: $,
  queryAll: $$,
  escape: esc,
  rawUrl: (project, path) => `/api/projects/${enc(project)}/raw?path=${encodeURIComponent(path)}`
});
var filesController = new FilesController(
  {
    projects: () => projects,
    loadTree: (project, force) => workbench.fileTree(project).load({ force }),
    readFile: (project, path, force = false) => workbench.readFile(project, path).load({ force }),
    writeFile: (input) => workbench.writeFile(input),
    editorText: filesEditorText,
    openEditor: (content, path, changed) => openFilesEditor($("#editor"), content, path, changed),
    confirmDiscard: () => confirm("Discard unsaved changes?"),
    navigate,
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancelScheduled: (handle) => clearTimeout(handle),
    errorMessage
  },
  filesView
);
filesView.attach(filesController);
var currentProject = () => filesController.project;
function renderProjectMenu() {
  filesController.syncProjects(projects);
}
function setProjectMenu(open, focus = false) {
  $("#projectMenu").classList.toggle("hidden", !open);
  $("#projectToggle").setAttribute("aria-expanded", String(open));
  if (open) {
    renderProjectMenu();
    if (focus)
      requestAnimationFrame(
        () => $('#projectMenu button[aria-selected="true"]')?.focus()
      );
  } else if (focus) $("#projectToggle").focus();
}
async function loadProjects() {
  projects = workbench.projects.all();
  filesController.syncProjects(projects);
  gitController.syncProject(currentProject());
}
var commandMatches = [];
function getCommands() {
  return [
    {
      type: "command",
      id: "cmd-live-trajectory",
      name: "Go to Live Trajectory",
      icon: "\u26A1",
      action: () => navigate("/live")
    },
    {
      type: "command",
      id: "cmd-live-chat",
      name: "Go to Live Chat",
      icon: "\u{1F4AC}",
      action: () => navigate("/live?tab=chat")
    },
    {
      type: "command",
      id: "cmd-agents",
      name: "Go to Agent Runs",
      icon: "\u{1F916}",
      action: () => navigate("/agents")
    },
    {
      type: "command",
      id: "cmd-new-agent",
      name: "New Agent Prompt...",
      icon: "\u2728",
      action: () => openAgentDialog()
    },
    {
      type: "command",
      id: "cmd-files",
      name: "Go to Files Explorer",
      icon: "\u{1F4C1}",
      action: () => navigate(fileRoute(currentProject()))
    },
    {
      type: "command",
      id: "cmd-git",
      name: "Go to Git Status & History",
      icon: "\u{1F33F}",
      action: () => navigate(`/git/${enc(currentProject())}`)
    },
    {
      type: "command",
      id: "cmd-collapse-tree",
      name: "Collapse File Tree",
      icon: "\u{1F4C2}",
      action: () => {
        filesController.collapse();
      }
    },
    {
      type: "command",
      id: "cmd-copy-link",
      name: "Copy Deep Link",
      icon: "\u{1F517}",
      action: () => copyDeepLink()
    }
  ];
}
function renderPalette() {
  const isCommandMode = $("#fileQuery")?.value.trim().startsWith(">");
  const list = isCommandMode ? commandMatches : paletteMatches;
  paletteIndex = Math.min(paletteIndex, Math.max(0, list.length - 1));
  $("#fileResults").innerHTML = list.length ? list.map((x, i) => {
    if (x.type === "command") {
      return `<div id="fileOption-${i}" class="paletteitem commanditem ${i === paletteIndex ? "active" : ""}" data-index="${i}" role="option" aria-selected="${i === paletteIndex}" tabindex="-1"><span class="cmdicon">${x.icon}</span><span class="path">${esc(x.name)}</span><span class="cmdtag">COMMAND</span></div>`;
    }
    const slash = x.path.lastIndexOf("/");
    return `<div id="fileOption-${i}" class="paletteitem ${i === paletteIndex ? "active" : ""}" data-index="${i}" role="option" aria-selected="${i === paletteIndex}" tabindex="-1"><span class="path">${esc(x.name)}</span><span class="dir">${esc(slash < 0 ? "" : x.path.slice(0, slash))}</span></div>`;
  }).join("") : `<div class="paletteempty">${isCommandMode ? "NO MATCHING COMMANDS" : "NO MATCHING FILES"}</div>`;
  const active = list.length ? `fileOption-${paletteIndex}` : "";
  $("#fileQuery").setAttribute("aria-activedescendant", active);
  $("#fileResultStatus").textContent = list.length ? `${list.length} results. ${list[paletteIndex]?.name || list[paletteIndex]?.path || ""} selected.` : "No matches.";
  $$(".paletteitem").forEach((b) => {
    b.onmouseenter = () => {
      paletteIndex = +b.dataset.index;
      renderPalette();
    };
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => choosePalette(+b.dataset.index);
  });
  $(".paletteitem.active")?.scrollIntoView({ block: "nearest" });
}
async function updatePalette() {
  const rawQ = $("#fileQuery").value.trim();
  if (rawQ.startsWith(">")) {
    const cmdQ = rawQ.slice(1).trim().toLowerCase();
    const allCmds = getCommands();
    commandMatches = cmdQ ? allCmds.filter((c) => c.name.toLowerCase().includes(cmdQ)) : allCmds;
    paletteIndex = 0;
    renderPalette();
    return;
  }
  const request = ++paletteRequest, q = rawQ;
  $("#fileResults").innerHTML = '<div class="paletteempty">SEARCHING\u2026</div>';
  try {
    const data = await workbench.searchFiles(currentProject(), q || " ").load();
    if (request !== paletteRequest) return;
    paletteMatches = data;
    paletteIndex = 0;
    renderPalette();
  } catch (e) {
    if (request === paletteRequest)
      $("#fileResults").innerHTML = `<div class="paletteempty">${esc(e.message)}</div>`;
  }
}
function queuePalette() {
  clearTimeout(paletteTimer);
  paletteTimer = setTimeout(updatePalette, 90);
}
function openPalette() {
  if (!$("#filePalette").classList.contains("hidden")) return;
  paletteReturnFocus = document.activeElement;
  $("#filePalette").classList.remove("hidden");
  $("#fileQuery").setAttribute("aria-expanded", "true");
  $("#fileQuery").value = "";
  paletteIndex = 0;
  updatePalette();
  requestAnimationFrame(() => $("#fileQuery").focus());
}
function closePalette() {
  if ($("#filePalette").classList.contains("hidden")) return;
  clearTimeout(paletteTimer);
  paletteRequest++;
  $("#filePalette").classList.add("hidden");
  $("#fileQuery").setAttribute("aria-expanded", "false");
  $("#fileQuery").setAttribute("aria-activedescendant", "");
  const target = paletteReturnFocus;
  paletteReturnFocus = null;
  if (target?.isConnected) requestAnimationFrame(() => target.focus());
}
async function choosePalette(index = paletteIndex) {
  const isCommandMode = $("#fileQuery")?.value.trim().startsWith(">");
  if (isCommandMode) {
    const cmd = commandMatches[index];
    if (!cmd) return;
    closePalette();
    cmd.action?.();
    return;
  }
  const item = paletteMatches[index];
  if (!item) return;
  closePalette();
  await filesController.open(item.path);
}
async function setLiveTab(tab, push = false) {
  liveMode = tab;
  const trajectory = tab === "trajectory";
  $("#chatTab").classList.toggle("active", !trajectory);
  $("#trajectoryTab").classList.toggle("active", trajectory);
  $("#chatTab").setAttribute("aria-selected", String(!trajectory));
  $("#trajectoryTab").setAttribute("aria-selected", String(trajectory));
  $("#liveChatView").classList.toggle("hidden", trajectory);
  $("#trajectoryView").classList.toggle("hidden", !trajectory);
  if (trajectory) {
    liveChat.stop();
    void (await ensureTrajectoryView()).load();
  } else {
    if (!liveChat.messages.length)
      void loadSession().finally(() => liveChat.start());
    else liveChat.start();
  }
  if (push) navigate(routeFor("session"));
}
$("#chatTab").onclick = () => setLiveTab("chat", true);
$("#trajectoryTab").onclick = () => setLiveTab("trajectory", true);
$("#trajectorySearch").oninput = async () => (await ensureTrajectoryView()).search($("#trajectorySearch").value);
$("#collapseTree").onclick = () => filesController.collapse();
$("#saveFile").onclick = () => filesController.save();
$("#fileQuery").oninput = queuePalette;
$("#fileQuery").onkeydown = (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteIndex = Math.min(paletteMatches.length - 1, paletteIndex + 1);
    renderPalette();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    renderPalette();
  } else if (e.key === "Home") {
    e.preventDefault();
    paletteIndex = 0;
    renderPalette();
  } else if (e.key === "End") {
    e.preventDefault();
    paletteIndex = Math.max(0, paletteMatches.length - 1);
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    choosePalette();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
  } else if (e.key === "Tab") {
    e.preventDefault();
    $("#fileQuery").focus();
  }
};
$("#filePalette").onmousedown = (e) => {
  if (e.target === $("#filePalette")) closePalette();
};
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
    e.preventDefault();
    openPalette();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
    e.preventDefault();
    toggleRunsInspector($);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void filesController.save();
  } else if (e.key === "Escape" && !$("#filePalette").classList.contains("hidden")) {
    e.preventDefault();
    closePalette();
  } else if (e.key === "Escape" && !$("#downloadMenu").classList.contains("hidden")) {
    e.preventDefault();
    setDownloadMenu(false);
  } else if (e.key === "Escape" && !$("#linkMenu").classList.contains("hidden")) {
    e.preventDefault();
    setLinkMenu(false);
  } else if (e.key === "Escape" && $("#webmcpDialog").open) {
    e.preventDefault();
    $("#webmcpDialog").close();
  }
});
addEventListener("beforeunload", (e) => {
  if (filesController.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
function directDeepLink() {
  return `${location.origin}${location.pathname}${location.search}${location.hash}`;
}
function setLinkMenu(open) {
  $("#linkMenu").classList.toggle("hidden", !open);
  $("#linkToggle").setAttribute("aria-expanded", String(open));
  if (!open) return;
  const url = directDeepLink();
  $("#deepLinkText").textContent = url;
  $("#openDeepLink").href = url;
}
async function copyDeepLink() {
  const button = $("#copyDeepLink");
  try {
    await navigator.clipboard.writeText(directDeepLink());
    button.textContent = "Copied";
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("#deepLinkText"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    button.textContent = "Selected";
  }
  setTimeout(() => button.textContent = "Copy link", 1400);
}
var webmcpBridgeArgs = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--category-experimental-webmcp",
  "--chrome-arg=--enable-features=WebMCP"
];
var webmcpClient = "claude";
var webmcpRegistration = { supported: false, registered: 0 };
function webmcpSetup(client = webmcpClient) {
  const bridge = `npx ${webmcpBridgeArgs.join(" ")}`;
  const command = client === "claude" ? `claude mcp add --scope user chrome-devtools -- ${bridge}` : `codex mcp add chrome-devtools -- ${bridge}`;
  const url = `${location.origin}/live`;
  const prompt = `Open ${url} in Chrome, wait for the Workbench to finish loading, then use list_webmcp_tools to discover its tools. Confirm that workbench_list_projects works and use the Workbench tools for this coding session.`;
  return { command, prompt };
}
function renderWebmcpSetup(client = webmcpClient) {
  webmcpClient = client;
  const setup = webmcpSetup(client);
  $("#webmcpCommand").textContent = setup.command;
  $("#webmcpPrompt").textContent = setup.prompt;
  $$("[data-webmcp-client]").forEach((button) => {
    const active = button.dataset.webmcpClient === client;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const mark = $("#webmcpStatusMark");
  mark.className = webmcpRegistration.registered ? "ready" : "bridge";
  $("#webmcpToolCount").textContent = `${webmcpRegistration.registered || 48} tools`;
  $("#webmcpStatusTitle").textContent = webmcpRegistration.registered ? `${webmcpRegistration.registered} tools ready in this browser` : "Desktop bridge required";
  $("#webmcpStatusText").textContent = webmcpRegistration.registered ? "Native WebMCP is active. Claude Code or Codex can discover this page now." : "Your assistant will launch a WebMCP-enabled Chrome using the command below.";
}
function openWebmcpSetup() {
  setLinkMenu(false);
  setDownloadMenu(false);
  renderWebmcpSetup();
  $("#webmcpDialog").showModal();
}
async function copyWebmcpValue(kind, button) {
  const value = webmcpSetup()[kind];
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
  } catch {
    const node = kind === "command" ? $("#webmcpCommand") : $("#webmcpPrompt");
    const range = document.createRange();
    range.selectNodeContents(node);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    button.textContent = "Selected";
  }
  setTimeout(() => button.textContent = "Copy", 1400);
}
function setDownloadMenu(open) {
  $("#downloadMenu").classList.toggle("hidden", !open);
  $("#downloadToggle").setAttribute("aria-expanded", String(open));
  if (!open) return;
  const project = projects.find((entry) => entry.id === currentProject()) || projects[0];
  if (!project) return;
  $("#downloadProjectName").textContent = project.name;
  $("#downloadSource").href = `/api/projects/${enc(project.id)}/source.zip`;
  $("#downloadBundle").href = `/api/projects/${enc(project.id)}/repository.bundle`;
}
$("#linkToggle").onclick = (event) => {
  event.stopPropagation();
  setDownloadMenu(false);
  setLinkMenu($("#linkMenu").classList.contains("hidden"));
};
$("#copyDeepLink").onclick = copyDeepLink;
$("#webmcpConnect").onclick = openWebmcpSetup;
$("#closeWebmcp").onclick = () => $("#webmcpDialog").close();
$$("[data-webmcp-client]").forEach(
  (button) => button.onclick = () => renderWebmcpSetup(button.dataset.webmcpClient)
);
$$("[data-copy-webmcp]").forEach(
  (button) => button.onclick = () => copyWebmcpValue(button.dataset.copyWebmcp, button)
);
$("#webmcpDialog").onclick = (event) => {
  if (event.target === $("#webmcpDialog")) $("#webmcpDialog").close();
};
$("#downloadToggle").onclick = (e) => {
  e.stopPropagation();
  setLinkMenu(false);
  setDownloadMenu($("#downloadMenu").classList.contains("hidden"));
};
addEventListener("click", (e) => {
  const target = e.target;
  if (!target.closest(".downloadmenu")) setDownloadMenu(false);
  if (!target.closest(".linkmenu")) setLinkMenu(false);
  if (!target.closest(".projectpicker")) setProjectMenu(false);
  if (!target.closest(".gitproject") && !target.closest("#gitProjectToggle") && !target.closest("#gitProjectMenu"))
    gitController.setProjectMenu(false);
});
$("#quickOpen").onclick = openPalette;
$$("#topNav button[data-page]").forEach(
  (b) => b.onclick = () => showPage(b.dataset.page, true)
);
$("#projectToggle").onclick = (e) => {
  e.stopPropagation();
  setProjectMenu($("#projectMenu").classList.contains("hidden"), true);
};
$("#projectMenu").onkeydown = (e) => {
  const items = $$("#projectMenu button"), i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (e.key === "Home") {
    e.preventDefault();
    items[0]?.focus();
  } else if (e.key === "End") {
    e.preventDefault();
    items.at(-1)?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu(false, true);
  } else if (e.key === "Tab") setProjectMenu(false);
};
$("#filter").oninput = (event) => filesController.setFilter(event.target.value);
$("#toggleAgentInspect")?.addEventListener(
  "click",
  () => toggleRunsInspector($)
);
$("#gitProjectToggle").onclick = (event) => {
  event.stopPropagation();
  gitController.setProjectMenu(
    $("#gitProjectMenu").classList.contains("hidden")
  );
};
$("#refreshGit").onclick = () => gitController.load(true);
window.bash = window.bash || { user: null, chat: null };
var origin = (() => {
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
})();
addEventListener("message", (e) => {
  if (origin && e.origin !== origin) return;
  if (e.data?.type === "bash-bootstrap") {
    window.bash = e.data.bash;
    const u = e.data.bash?.user;
    $("#identity").innerHTML = identityHtml(u);
    setComposerIdentity(u);
    if (liveChat.messages.length) liveChat.render();
  } else if (e.data?.type === "bash-navigate" && typeof e.data.path === "string") {
    navigate(e.data.path);
  }
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented && $("#filePalette").classList.contains("hidden") && $("#downloadMenu").classList.contains("hidden") && !dlg.open && window.parent !== window)
    window.parent.postMessage({ type: "bash-escape" }, origin || "*");
});
var dlg = $("#agentDialog");
var agentPrompt = $("#agentPrompt");
var submitAgentButton = $("#submitAgent");
var agentSubmitting = false;
function openAgentDialog() {
  if (workflowView.mode === "workflows") {
    alert(
      "Use the Workflows view or WebMCP workflow tools to create workflows."
    );
    return;
  }
  $("#agentError").textContent = "";
  setComposerIdentity(window.bash?.user);
  dlg.showModal();
  requestAnimationFrame(() => agentPrompt.focus());
}
function closeAgentDialog() {
  if (!agentSubmitting) dlg.close();
}
async function submitAgent() {
  if (agentSubmitting || !agentPrompt.value.trim()) return;
  agentSubmitting = true;
  const prompt = agentPrompt.value.trim();
  submitAgentButton.classList.add("loading");
  submitAgentButton.disabled = true;
  try {
    const title = prompt.split("\n")[0].slice(0, 100);
    const id = crypto.randomUUID();
    runs.selectedId = id;
    dlg.close();
    $("#agentForm").reset();
    navigate(`/agents/${enc(id)}`);
    await workbench.createRun({
      id,
      project: currentProject() || projects[0]?.id,
      title,
      prompt,
      creator: window.bash?.user || null,
      originChat: window.bash?.chat || null
    });
  } catch (err) {
    runs.selectedId = null;
    agentPrompt.value = prompt;
    if (!dlg.open) dlg.showModal();
    navigate("/agents", true);
    $("#agentError").textContent = errorMessage(err);
  } finally {
    agentSubmitting = false;
    submitAgentButton.classList.remove("loading");
    submitAgentButton.disabled = false;
  }
}
$("#newAgent").onclick = openAgentDialog;
dlg.oncancel = (e) => {
  e.preventDefault();
  closeAgentDialog();
};
dlg.onmousedown = (e) => {
  if (e.target === dlg) closeAgentDialog();
};
agentPrompt.onkeydown = (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeAgentDialog();
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitAgent();
  }
};
$("#agentForm").onsubmit = (e) => {
  e.preventDefault();
  submitAgent();
};
async function routeProject(id) {
  await collectionsReady;
  const routed = await filesController.routeProject(id);
  if (routed && !filesController.files.length) await filesController.loadTree();
  if (routed) gitController.syncProject(currentProject());
  return routed;
}
function registerRoutes() {
  page("*", (_ctx, next) => {
    if (filesController.dirty && !confirm("Discard unsaved changes?")) {
      window.history.pushState(null, "", filesController.route());
      return;
    }
    filesController.discardChanges();
    next();
  });
  page("/", () => page.replace("/live"));
  page("/session", () => page.replace("/live"));
  page("/live", (context) => {
    const tab = new URLSearchParams(context.querystring).get("tab");
    liveMode = tab === "trajectory" ? "trajectory" : "chat";
    showPage("session");
    void setLiveTab(tab === "trajectory" ? "trajectory" : "chat");
  });
  page("/agents", () => {
    runs.clearSelection();
    showPage("agents");
    runs.load();
  });
  page("/agents/:id", (context) => {
    showPage("agents");
    const id = context.params.id;
    void collectionsReady.then(
      () => runs.load().then(() => {
        if (runs.has(id)) runs.select(id, { render: true, push: false });
        else page.replace("/agents");
      })
    );
  });
  page("/files/:project", async (context) => {
    if (!await routeProject(context.params.project)) return;
    showPage("files");
    filesController.routeRoot();
  });
  page("/files/:project/:path(.*)", async (context) => {
    if (!await routeProject(context.params.project)) return;
    showPage("files");
    await filesController.routeFile(context.params.path);
  });
  page("/git/:project/:commit", async (context) => {
    if (!await routeProject(context.params.project)) return;
    showPage("git");
    await gitController.route(currentProject(), context.params.commit);
  });
  page("/git/:project", async (context) => {
    if (!await routeProject(context.params.project)) return;
    showPage("git");
    await gitController.route(currentProject());
  });
  page("*", () => page.replace("/live"));
  page.start({ click: false, popstate: true, dispatch: true });
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "workbench-update") return;
    const key = `workbench-update:${event.data.cache}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    location.reload();
  });
  navigator.serviceWorker.register("/sw.js").catch(() => {
  });
}
workbench.runs.subscribe((value) => {
  if (!$("#agents").classList.contains("hidden")) runs.update(value);
  else runs.runs = value;
});
workbench.projects.subscribe((value) => {
  projects = value;
  filesController.syncProjects(value);
  gitController.syncProject(currentProject());
});
ensureWorkbenchSession().then(() => {
  registerRoutes();
  return workbench.start();
}).then(async () => {
  await Promise.all([loadProjects(), runs.load()]);
  resolveCollectionsReady();
  $("#workflowsMode").onclick = async () => {
    workflowView = await ensureWorkflowView();
    workflowView.setMode("workflows");
  };
  const webMcp = await registerWorkbenchWebMcp(workbench, {
    navigate,
    currentProject
  });
  webmcpRegistration = webMcp;
  renderWebmcpSetup();
  if (webMcp.supported)
    console.info(
      webMcp.error ? `WebMCP registration failed: ${webMcp.error}` : `WebMCP ready: ${webMcp.registered} Workbench tools`
    );
}).catch((error) => {
  const authError = document.querySelector("#authError");
  if (authError) authError.textContent = errorMessage(error);
});
