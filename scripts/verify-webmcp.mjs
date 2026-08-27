#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs/promises";

const url = process.env.BASH_WORKBENCH_WEBMCP_URL || process.argv[2] || "http://127.0.0.1:8010/live";
const executable = process.env.BASH_WORKBENCH_CHROME || "/usr/local/bin/chromium";
const timeoutMs = Number(process.env.BASH_WORKBENCH_WEBMCP_TIMEOUT_MS) || 90_000;
const args = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--headless",
  "--isolated",
  `--executable-path=${executable}`,
  "--category-experimental-webmcp",
  "--chrome-arg=--enable-features=WebMCP",
  "--chrome-arg=--no-sandbox",
  "--no-usage-statistics",
  "--no-performance-crux",
];

const child = spawn("npx", args, { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});

const request = (method, params = {}) => {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const notify = (method, params = {}) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const call = (name, args) => request("tools/call", { name, arguments: args });
const outputText = (result) =>
  (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timer = setTimeout(() => {
  child.kill("SIGTERM");
  console.error(`WebMCP verification timed out after ${timeoutMs}ms`);
  process.exitCode = 1;
}, timeoutMs);

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bash-workbench-webmcp-verifier", version: "1.0.0" },
  });
  notify("notifications/initialized");

  const available = await request("tools/list");
  const bridgeTools = new Set((available.tools ?? []).map((tool) => tool.name));
  for (const required of ["new_page", "navigate_page", "list_webmcp_tools", "execute_webmcp_tool", "evaluate_script"])
    if (!bridgeTools.has(required)) throw new Error(`Bridge is missing ${required}`);

  const opened = outputText(await call("new_page", { url }));
  let pageId = Number(opened.match(/\n(\d+):[^\n]+\[selected\]/)?.[1]);
  if (!Number.isFinite(pageId)) throw new Error(`Could not determine selected page ID:\n${opened}`);

  let listing = outputText(await call("list_webmcp_tools", { pageId }));
  if (!listing.includes('name="workbench_list_projects"')) {
    const credential = (await fs.readFile(new URL("../.state/workflows-v1/control.token", import.meta.url), "utf8")).trim();
    const authenticated = outputText(await call("evaluate_script", {
      pageId,
      function: `async () => { const response = await fetch('/api/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ${JSON.stringify(credential)} }) }); return response.ok; }`,
    }));
    if (!authenticated.includes("true")) throw new Error("Could not authenticate isolated WebMCP browser");
    await call("navigate_page", { pageId, type: "reload", ignoreCache: true });
    await sleep(1_000);
    const sessionCheck = outputText(await call("evaluate_script", { pageId, function: `async () => await fetch('/api/auth/session').then(response => response.json())` }));
    if (!sessionCheck.includes('"authenticated":true')) throw new Error(`Isolated browser session did not persist: ${sessionCheck}`);
  }
  const reopened = outputText(await call("new_page", { url }));
  const authenticatedPageId = Number(reopened.match(/\n(\d+):[^\n]+\[selected\]/)?.[1]);
  if (Number.isFinite(authenticatedPageId)) pageId = authenticatedPageId;
  const deadline = Date.now() + Math.min(45_000, timeoutMs - 2_000);
  let registeredCount = 0;
  while (Date.now() < deadline) {
    const status = outputText(await call("evaluate_script", { pageId, function: `async () => document.modelContext ? (await document.modelContext.getTools()).length : 0` }));
    registeredCount = Number(status.match(/(\d+)/)?.[1] || 0);
    if (registeredCount >= 48) break;
    await sleep(500);
  }
  if (registeredCount < 48) throw new Error(`Expected 48 registered Workbench tools on page ${pageId}, found ${registeredCount}`);

  const invoked = await call("execute_webmcp_tool", {
    pageId,
    toolName: "workbench_list_projects",
    input: "{}",
  });
  const result = outputText(invoked);
  if (invoked.isError || !result.includes("kyoot-workbench"))
    throw new Error(`workbench_list_projects invocation failed:\n${result}`);

  for (const [toolName, input] of [
    ["workbench_spawn_agent", { project: "__verification_missing__", prompt: "do not run" }],
    ["workbench_spawn_workflow", { title: "verification", tasks: [{ id: "verify", project: "__verification_missing__", prompt: "do not run" }] }],
    ["workbench_add_workflow_tasks", { workflowId: "__verification_missing__", tasks: [{ id: "verify", project: "kyoot-workbench", prompt: "do not run" }] }],
  ]) {
    const probe = await call("execute_webmcp_tool", { pageId, toolName, input: JSON.stringify(input) });
    const text = outputText(probe);
    if (text.includes(`Tool ${toolName} not found`)) throw new Error(`Missing required WebMCP tool: ${toolName}`);
  }
  const execResult = await call("execute_webmcp_tool", {
    pageId,
    toolName: "workbench_exec",
    input: JSON.stringify({ project: "kyoot-workbench", command: "printf WEBMCP_EXEC_READY" }),
  });
  if (execResult.isError || !outputText(execResult).includes("WEBMCP_EXEC_READY"))
    throw new Error(`workbench_exec invocation failed:\n${outputText(execResult)}`);

  if (/^(?:1|true|yes)$/i.test(process.env.BASH_WORKBENCH_WEBMCP_AGENT_VISIBILITY || "")) {
    const title = `WebMCP visibility ${Date.now()}`;
    const uiPage = outputText(await call("new_page", { url: new URL("/agents", url).href }));
    const uiPageId = Number(uiPage.match(/\n(\d+):[^\n]+\[selected\]/)?.[1]);
    if (!Number.isFinite(uiPageId)) throw new Error(`Could not open Workbench Agents page:\n${uiPage}`);
    await sleep(1_000);
    const externalPage = outputText(await call("new_page", { url }));
    const externalPageId = Number(externalPage.match(/\n(\d+):[^\n]+\[selected\]/)?.[1]);
    if (!Number.isFinite(externalPageId)) throw new Error(`Could not open external WebMCP page:\n${externalPage}`);
    await sleep(1_000);
    const created = await call("execute_webmcp_tool", {
      pageId: externalPageId,
      toolName: "workbench_spawn_agent",
      input: JSON.stringify({ project: "kyoot-workbench", title, prompt: "Visibility acceptance task: report that the agent started, without modifying files." }),
    });
    if (created.isError) throw new Error(`Agent creation failed:\n${outputText(created)}`);
    let visible = "";
    const visibilityDeadline = Date.now() + 15_000;
    while (Date.now() < visibilityDeadline) {
      visible = outputText(await call("evaluate_script", {
        pageId: uiPageId,
        function: `() => [...document.querySelectorAll('#agentList .agent')].map(element => ({ id: element.dataset.id, text: element.textContent }))`,
      }));
      if (visible.includes(title)) break;
      await sleep(250);
    }
    if (!visible.includes(title)) throw new Error(`External WebMCP agent did not appear in the connected Agents list:\n${visible}`);
    const idMatch = visible.match(new RegExp(`"id":"([^"]+)"[^}]*"text":"[^"]*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    if (idMatch?.[1])
      await call("execute_webmcp_tool", {
        pageId: externalPageId,
        toolName: "workbench_stop_run",
        input: JSON.stringify({ id: idMatch[1] }),
      });
    console.log(`WebMCP agent visibility passed: ${title} appeared in an already-connected Agents list.`);
  }
  console.log("WebMCP verification passed: registered 48 Workbench tools; probed agent/workflow spawning and invoked project listing plus bounded exec.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.kill("SIGTERM");
  lines.close();
}
