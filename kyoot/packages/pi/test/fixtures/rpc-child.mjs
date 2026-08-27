import readline from "node:readline";

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    output({ id: command.id, type: "response", command: "prompt", success: true });
    output({ type: "agent_start" });
    output({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    output({ type: "agent_end", messages: [] });
    return;
  }
  if (command.type === "get_state") {
    output({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: { provider: "bashtv", id: "free" },
        thinkingLevel: "low",
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        sessionId: "fixture",
        sessionName: null,
        messageCount: 1,
        pendingMessageCount: 0,
      },
    });
    return;
  }
  output({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error: `unsupported: ${command.type}`,
  });
});

process.on("SIGTERM", () => process.exit(0));
