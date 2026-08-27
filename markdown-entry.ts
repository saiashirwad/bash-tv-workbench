import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

marked.setOptions({ gfm: true, breaks: true });
const renderer = new marked.Renderer();
renderer.link = ({ href, title, tokens }) => {
  const text = marked.Parser.parseInline(tokens);
  const safe = /^(https?:|mailto:)/i.test(href || "") ? href : "#";
  return `<a href="${safe}"${title ? ` title="${title}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
renderer.code = ({ text, lang }) => {
  const requested = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  let html,
    language = requested;
  if (requested && hljs.getLanguage(requested))
    html = hljs.highlight(text, {
      language: requested,
      ignoreIllegals: true,
    }).value;
  else {
    const auto = hljs.highlightAuto(text);
    html = auto.value;
    language = auto.language || "";
  }
  return `<div class="codeblock"><div class="codelabel">${language || "text"}</div><pre><code class="hljs language-${language}">${html}</code></pre></div>`;
};
const extensionLanguages = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  sql: "sql",
};
export function languageForPath(file = "") {
  const name = String(file).split("/").pop() || "",
    ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return (
    extensionLanguages[ext] ||
    (name === "Dockerfile"
      ? "dockerfile"
      : name === "Makefile"
        ? "makefile"
        : "plaintext")
  );
}
export function highlightLine(source, file = "") {
  const language = languageForPath(file);
  if (language !== "plaintext" && hljs.getLanguage(language))
    return hljs.highlight(String(source), { language, ignoreIllegals: true })
      .value;
  return String(source).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
export function renderMarkdown(source) {
  return DOMPurify.sanitize(
    String(marked.parse(String(source || ""), { renderer })),
    {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel"],
    FORBID_TAGS: [
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
    ],
      FORBID_ATTR: ["style", "onerror", "onclick"],
    },
  );
}
