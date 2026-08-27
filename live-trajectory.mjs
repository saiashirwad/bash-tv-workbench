const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item) => item && (item.type === "text" || typeof item.text === "string"),
    )
    .map((item) => item.text || "")
    .join("\n");
};

const contentText = (content, type) =>
  (Array.isArray(content) ? content : [])
    .filter((item) => item?.type === type)
    .map((item) => item.text || item.thinking || "")
    .filter(Boolean)
    .join("\n");

const compactValue = (value, limit = 256 * 1024) => {
  if (value == null) return null;
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: "Value is not JSON serializable" };
  }
  return encoded.length <= limit
    ? value
    : { truncated: true, preview: encoded.slice(0, limit) };
};

const oneLine = (value, limit) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

/**
 * Incrementally derives small trajectory summaries and bounded event details.
 * Call update after LiveSessionReader.refresh(). Page queries never rebuild the
 * session and never return full event bodies.
 */
export class LiveTrajectoryIndex {
  constructor() {
    this.reset(null);
  }

  reset(identity) {
    this.identity = identity;
    this.rowCount = 0;
    this.turn = 0;
    this.events = [];
    this.details = new Map();
    this.callTimes = new Map();
    this.start = null;
    this.end = null;
    this.tools = 0;
    this.users = 0;
  }

  add(input) {
    const sequence = this.events.length + 1;
    const baseId = String(input.id || `trajectory-${sequence}`);
    const id = this.details.has(baseId) ? `${baseId}-${sequence}` : baseId;
    const detail = { ...input, id, sequence };
    const source =
      detail.type === "tool"
        ? JSON.stringify(detail.args || {})
        : detail.text || "";
    const summary = {
      id,
      sequence,
      type: String(detail.type || "event"),
      turn: Math.max(0, Number(detail.turn) || 0),
      at: detail.at ? String(detail.at) : null,
      label: String(detail.label || detail.type || "Event"),
      summary: oneLine(source, detail.type === "tool" ? 180 : 220),
      ...(detail.toolName ? { toolName: String(detail.toolName) } : {}),
      ...(detail.durationMs != null
        ? { durationMs: Math.max(0, Number(detail.durationMs)) }
        : {}),
      ...(detail.isError ? { isError: true } : {}),
    };
    this.events.push(summary);
    this.details.set(id, {
      ...detail,
      text: detail.text ? String(detail.text).slice(0, 64 * 1024) : undefined,
      args: compactValue(detail.args),
      details: compactValue(detail.details),
      usage: compactValue(detail.usage, 64 * 1024),
    });
    if (summary.at) {
      this.start ??= summary.at;
      this.end = summary.at;
    }
    if (summary.type === "tool") this.tools++;
    if (summary.type === "user") this.users++;
  }

  update(identity, rows) {
    if (identity !== this.identity || rows.length < this.rowCount)
      this.reset(identity);
    for (const row of rows.slice(this.rowCount)) {
      const message = row.type === "message" ? row.message : null;
      if (!message) continue;
      const at = row.timestamp || message.timestamp || null;
      if (message.role === "user") {
        this.turn++;
        this.add({
          id: row.id,
          type: "user",
          turn: this.turn,
          at,
          label: "User",
          text: textOf(message.content),
        });
        continue;
      }
      if (message.role === "assistant") {
        const thinking = contentText(message.content, "thinking");
        const text = contentText(message.content, "text");
        if (thinking)
          this.add({
            id: `${row.id}-thinking`,
            type: "reasoning",
            turn: this.turn,
            at,
            label: "Thinking",
            text: thinking,
            usage: message.usage || null,
          });
        if (text)
          this.add({
            id: `${row.id}-text`,
            type: "assistant",
            turn: this.turn,
            at,
            label: "Assistant",
            text,
            usage: message.usage || null,
          });
        for (const call of Array.isArray(message.content)
          ? message.content
          : []) {
          if (call?.type !== "toolCall" && call?.type !== "tool_call") continue;
          const id = call.id || `${row.id}-tool`;
          this.callTimes.set(id, at);
          this.add({
            id,
            type: "tool",
            turn: this.turn,
            at,
            label: call.name || call.toolName || "Tool",
            toolName: call.name || call.toolName,
            args: call.arguments || call.args || null,
          });
        }
        continue;
      }
      if (message.role === "toolResult") {
        const started = this.callTimes.get(message.toolCallId);
        const durationMs =
          started && at
            ? Math.max(0, new Date(at).getTime() - new Date(started).getTime())
            : null;
        this.add({
          id: row.id,
          type: message.isError ? "error" : "result",
          turn: this.turn,
          at,
          label: message.toolName || "Result",
          toolName: message.toolName,
          callId: message.toolCallId,
          text: textOf(message.content),
          details: message.details || null,
          isError: Boolean(message.isError),
          durationMs,
        });
      }
    }
    this.rowCount = rows.length;
    return this;
  }

  overview() {
    return {
      turns: this.turn,
      tools: this.tools,
      users: this.users,
      start: this.start,
      end: this.end,
      durationMs:
        this.start && this.end
          ? Math.max(
              0,
              new Date(this.end).getTime() - new Date(this.start).getTime(),
            )
          : 0,
    };
  }

  page({ before = null, limit = 100, query = "" } = {}) {
    const normalized = String(query).trim().toLowerCase();
    const matching = normalized
      ? this.events.filter((event) =>
          `${event.type} ${event.label} ${event.toolName || ""} ${event.summary}`
            .toLowerCase()
            .includes(normalized),
        )
      : this.events;
    const eligible =
      before == null
        ? matching
        : matching.filter((event) => event.sequence < before);
    const events = eligible.slice(-Math.max(1, Math.min(250, limit)));
    const previousCursor = events.at(0)?.sequence ?? null;
    return {
      events,
      previousCursor,
      moreBefore:
        previousCursor != null &&
        eligible.some((event) => event.sequence < previousCursor),
      total: matching.length,
      overview: this.overview(),
    };
  }

  event(id) {
    const value = this.details.get(String(id));
    if (!value)
      throw Object.assign(new Error("Unknown trajectory event"), {
        status: 404,
      });
    return value;
  }
}
