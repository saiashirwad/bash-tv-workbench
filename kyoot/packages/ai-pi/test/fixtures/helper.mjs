import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const command = JSON.parse(line);
  if (command.model !== "free") process.exit(2);
  if (command.request.messages.some((message) => message.content === "hang")) {
    setInterval(() => {}, 1_000);
    continue;
  }
  if (command.request.messages.some((message) => message.content === "fail")) {
    process.stdout.write(
      `${JSON.stringify({
        type: "error",
        error: { kind: "fixture", message: "authorization: secret-value" },
      })}\n`,
    );
    process.exitCode = 1;
    break;
  }
  const streaming = command.request.messages.some((message) => message.content === "stream");
  if (streaming) {
    process.stdout.write(`${JSON.stringify({ type: "text", text: "first" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const answer = command.request.tools?.find((tool) => tool.name === "answer");
  const completion = answer
    ? {
        text: "",
        toolCalls: [{ id: "answer-1", name: "answer", arguments: '{"value":42}' }],
        usage: { input: 9, output: 2 },
      }
    : {
        text: streaming ? "first" : `fixture:${command.thinking}`,
        toolCalls: [],
        usage: { input: 4, output: 1 },
      };
  if (completion.text && !streaming)
    process.stdout.write(`${JSON.stringify({ type: "text", text: completion.text })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", completion })}\n`);
  break;
}
