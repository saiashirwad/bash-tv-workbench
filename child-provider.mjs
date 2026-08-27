const info = (() => {
  try {
    return JSON.parse(process.env.BASHTV_FREE_MODEL_INFO || "{}");
  } catch {
    return {};
  }
})();
export default function registerBashTvFree(pi) {
  const baseUrl = (process.env.BASHTV_FREE_LLM_URL || "").trim();
  if (!baseUrl)
    throw new Error("Bash.tv free model is not provisioned in this process");
  const headers = {};
  if (process.env.BASHTV_TUNNEL_AUTH_TOKEN)
    headers["x-bashtv-tunnel-auth"] = process.env.BASHTV_TUNNEL_AUTH_TOKEN;
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET)
    headers["x-vercel-protection-bypass"] =
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  pi.registerProvider("bashtv", {
    baseUrl,
    apiKey: "API_REFRESH_TOKEN",
    headers,
    models: [
      {
        id: "free",
        name: info.displayName || "Bash.tv Free",
        api: "openai-completions",
        reasoning: true,
        supportedThinkingLevels: ["off", "low"],
        input: Array.isArray(info.input) ? info.input : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: info.contextWindow || 128000,
        maxTokens: info.maxTokens || 16384,
        compat: {
          thinkingFormat: "openrouter",
          reasoningEffortMap: { low: "on" },
        },
      },
    ],
  });
}
