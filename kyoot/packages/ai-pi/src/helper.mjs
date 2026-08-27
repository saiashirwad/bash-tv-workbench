import readline from "node:readline";
import { pathToFileURL } from "node:url";

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const redact = (message) => {
  let safe = message;
  for (const key of [
    "API_REFRESH_TOKEN",
    "BASHTV_FREE_LLM_URL",
    "BASHTV_TUNNEL_AUTH_TOKEN",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
  ]) {
    const value = process.env[key];
    if (value) safe = safe.split(value).join("[redacted]");
  }
  return safe
    .replace(/(authorization|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s,;]+/gi, "[redacted-url]")
    .slice(0, 4_000);
};
const fail = (kind, error) => {
  const message = error instanceof Error ? error.message : String(error);
  output({ type: "error", error: { kind, message: redact(message) } });
  process.exitCode = 1;
};

const modelInfo = () => {
  try {
    const value = JSON.parse(process.env.BASHTV_FREE_MODEL_INFO || "{}");
    return {
      displayName: typeof value.displayName === "string" ? value.displayName : "Bash.tv Free",
      contextWindow:
        typeof value.contextWindow === "number" && value.contextWindow > 0
          ? value.contextWindow
          : 128_000,
      maxTokens:
        typeof value.maxTokens === "number" && value.maxTokens > 0 ? value.maxTokens : 16_384,
      input:
        Array.isArray(value.input) && value.input.includes("image") ? ["text", "image"] : ["text"],
    };
  } catch {
    return {
      displayName: "Bash.tv Free",
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ["text"],
    };
  }
};

const toolNames = (messages) => {
  const names = new Map();
  for (const message of messages)
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  return names;
};

const parseArguments = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const toContext = (request, model) => {
  const names = toolNames(request.messages);
  const systems = [];
  const messages = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      systems.push(message.content);
    } else if (message.role === "user") {
      messages.push({ role: "user", content: message.content, timestamp: Date.now() });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall",
            id: call.id,
            name: call.name,
            arguments: parseArguments(call.arguments),
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    } else {
      messages.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: names.get(message.toolCallId) ?? "tool",
        content: [{ type: "text", text: message.content }],
        isError: message.content.startsWith("error:"),
        timestamp: Date.now(),
      });
    }
  }
  return {
    systemPrompt: systems.join("\n\n"),
    messages,
    tools: request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
};

const run = async (command) => {
  if (command?.type !== "complete" || command.model !== "free")
    throw new Error("unsupported Bash.tv model command");
  const baseUrl = process.env.BASHTV_FREE_LLM_URL?.trim();
  if (!baseUrl) throw new Error("Bash.tv free model is not provisioned in this process");

  const piAiPath = process.env.KYOOT_PI_AI_PATH;
  if (!piAiPath) throw new Error("Pi AI module path is not configured");
  const { streamSimple } = await import(pathToFileURL(piAiPath).href);
  const info = modelInfo();
  const headers = {};
  if (process.env.BASHTV_TUNNEL_AUTH_TOKEN)
    headers["x-bashtv-tunnel-auth"] = process.env.BASHTV_TUNNEL_AUTH_TOKEN;
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET)
    headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const model = {
    id: "free",
    name: info.displayName,
    provider: "bashtv",
    api: "openai-completions",
    baseUrl,
    headers,
    reasoning: true,
    supportedThinkingLevels: ["off", "low"],
    input: info.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: {
      thinkingFormat: "openrouter",
      reasoningEffortMap: { low: "on" },
    },
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const stream = streamSimple(model, toContext(command.request, model), {
    apiKey: process.env.API_REFRESH_TOKEN || "",
    signal: controller.signal,
    reasoning: command.thinking === "low" ? "low" : undefined,
    toolChoice: command.request.toolChoice,
    temperature: command.request.temperature,
    maxTokens: command.request.maxTokens,
  });
  for await (const event of stream)
    if (event.type === "text_delta" && event.delta) output({ type: "text", text: event.delta });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted")
    throw new Error(message.errorMessage || `model ${message.stopReason}`);
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.arguments),
    }));
  output({
    type: "result",
    completion: {
      text,
      toolCalls,
      usage: { input: message.usage.input, output: message.usage.output },
    },
  });
};

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let handled = false;
for await (const line of lines) {
  if (handled || !line.trim()) continue;
  handled = true;
  try {
    await run(JSON.parse(line));
  } catch (error) {
    fail("model", error);
  }
  break;
}
