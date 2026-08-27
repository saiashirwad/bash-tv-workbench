import assert from "node:assert/strict";
import test from "node:test";
import { RunsController, filterRuns } from "../public/runs.js";

const run = (id, values = {}) => ({
  id,
  title: `Run ${id}`,
  prompt: `Prompt ${id}`,
  status: "completed",
  creator: { username: "Ada" },
  events: [],
  ...values,
});

function harness(initial = []) {
  const calls = [];
  const lists = [];
  const details = [];
  const drafts = [];
  const alerts = [];
  let values = initial;
  const adapter = {
    all: () => values,
    refresh: async () => calls.push(["refresh"]),
    stop: async (id) => calls.push(["stop", id]),
    compact: async (id) => calls.push(["compact", id]),
    message: async (id, prompt, attribution) =>
      calls.push(["message", id, prompt, attribution]),
    attribution: () => ({
      creator: { username: "Grace" },
      originChat: { id: "chat" },
    }),
    navigate: (url) => calls.push(["navigate", url]),
    alert: (message) => alerts.push(message),
    escape: String,
    renderMarkdown: String,
    highlightLine: String,
  };
  const view = {
    renderList: (runs, selected) =>
      lists.push({ ids: runs.map(({ id }) => id), selected }),
    renderDetail: (value, draft) => details.push({ value, draft }),
    showListError: (error, hasRuns) =>
      calls.push(["error", error.message, hasRuns]),
    setDraft: (value) => drafts.push(value),
    setCompactPending: (value) => calls.push(["compactPending", value]),
    setFollowupPending: (value) => calls.push(["followupPending", value]),
    scrollTranscriptToEnd: () => calls.push(["scroll"]),
  };
  const controller = new RunsController(adapter, view);
  return {
    controller,
    calls,
    lists,
    details,
    drafts,
    alerts,
    setValues: (next) => (values = next),
  };
}

test("run filtering is case-insensitive and always sorts newest first", () => {
  const values = [
    run("one", { title: "Fix Parser", createdAt: "2026-01-01T00:00:00.000Z" }),
    run("two", {
      prompt: "Write DOCS",
      creator: { username: "Lin" },
      createdAt: "2026-01-03T00:00:00.000Z",
    }),
    run("three", { createdAt: "2026-01-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    filterRuns(values, "").map(({ id }) => id),
    ["two", "three", "one"],
  );
  assert.deepEqual(
    filterRuns(values, "parser").map(({ id }) => id),
    ["one"],
  );
  assert.deepEqual(
    filterRuns(values, "docs").map(({ id }) => id),
    ["two"],
  );
  assert.deepEqual(
    filterRuns(values, "LIN").map(({ id }) => id),
    ["two"],
  );
});

test("selection, filtering, and run event updates produce the expected views", () => {
  const first = run("one");
  const h = harness([first, run("two")]);
  h.controller.update([first, run("two")]);
  h.controller.select("one");
  h.controller.setFilter("two");
  const updated = run("one", {
    status: "running",
    events: [{ type: "message", text: "new" }],
  });
  h.controller.update([updated, run("two")]);

  assert.deepEqual(h.lists.at(-1), { ids: ["two"], selected: "one" });
  assert.equal(h.details.at(-1).value.events[0].text, "new");
  assert.deepEqual(
    h.calls.find((call) => call[0] === "navigate"),
    ["navigate", "/agents/one"],
  );
});

test("drafts are preserved per run across selection and event updates", () => {
  const h = harness([run("one"), run("two")]);
  h.controller.update([run("one"), run("two")]);
  h.controller.select("one", { push: false });
  h.controller.setDraft("one", "unfinished one");
  h.controller.select("two", { push: false });
  h.controller.setDraft("two", "unfinished two");
  h.controller.update([
    run("one", { events: [{ type: "reasoning", text: "tick" }] }),
    run("two"),
  ]);
  h.controller.select("one", { push: false });

  assert.equal(h.details.at(-1).draft, "unfinished one");
  h.controller.select("two", { push: false });
  assert.equal(h.details.at(-1).draft, "unfinished two");
});

test("run actions delegate with attribution and optimistic pending state", async () => {
  const h = harness([run("one")]);
  h.controller.update([run("one")]);
  h.controller.setDraft("one", "  continue  ");
  await h.controller.submitFollowup("one");
  await h.controller.compact("one");
  await h.controller.stop("one");

  assert.deepEqual(
    h.calls.find((call) => call[0] === "message"),
    [
      "message",
      "one",
      "continue",
      { creator: { username: "Grace" }, originChat: { id: "chat" } },
    ],
  );
  assert.deepEqual(h.drafts, ["", ""]);
  assert.ok(h.calls.some((call) => call[0] === "compact" && call[1] === "one"));
  assert.ok(h.calls.some((call) => call[0] === "stop" && call[1] === "one"));
});

test("failed follow-up restores its draft", async () => {
  const h = harness([run("one")]);
  h.controller.update([run("one")]);
  h.controller.setDraft("one", "retry me");
  h.controller.adapter.message = async () => {
    throw new Error("offline");
  };
  await h.controller.submitFollowup("one");

  assert.equal(h.controller.draft("one"), "retry me");
  assert.equal(h.drafts.at(-1), "retry me");
  assert.deepEqual(h.alerts, ["offline"]);
});
