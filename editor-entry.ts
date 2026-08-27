import { EditorView, basicSetup } from "codemirror";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";

const githubDark = EditorView.theme(
  {
    "&": { height: "100%", color: "#e6edf3", backgroundColor: "#0d1117" },
    ".cm-content": { caretColor: "#58a6ff" },
    ".cm-cursor,.cm-dropCursor": { borderLeftColor: "#58a6ff" },
    "&.cm-focused .cm-selectionBackground,.cm-selectionBackground,.cm-content ::selection":
      { backgroundColor: "#264f78" },
    ".cm-panels": { backgroundColor: "#161b22", color: "#e6edf3" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid #30363d" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #30363d" },
    ".cm-searchMatch": {
      backgroundColor: "#9e6a034d",
      outline: "1px solid #d29922",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#1f6feb66" },
    ".cm-activeLine": { backgroundColor: "#161b2280" },
    ".cm-selectionMatch": { backgroundColor: "#3fb95033" },
    ".cm-matchingBracket,.cm-nonmatchingBracket": {
      backgroundColor: "#6e768166",
      outline: "1px solid #8b949e",
    },
    ".cm-gutters": {
      backgroundColor: "#0d1117",
      color: "#6e7681",
      borderRight: "1px solid #21262d",
    },
    ".cm-activeLineGutter": { backgroundColor: "#161b22", color: "#e6edf3" },
    ".cm-foldPlaceholder": {
      backgroundColor: "#21262d",
      border: "1px solid #30363d",
      color: "#8b949e",
    },
    ".cm-tooltip": { border: "1px solid #30363d", backgroundColor: "#161b22" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "#1f6feb",
      color: "#ffffff",
    },
    ".cm-scroller": { overflow: "auto" },
  },
  { dark: true },
);
const synthwaveHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#ff5db1" },
  {
    tag: [tags.propertyName, tags.attributeName, tags.macroName],
    color: "#ff8fcb",
  },
  { tag: tags.character, color: "#a9ed70" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#35d9ff" },
  {
    tag: [
      tags.color,
      tags.constant(tags.name),
      tags.standard(tags.name),
      tags.bool,
      tags.atom,
    ],
    color: "#b991ff",
  },
  {
    tag: [tags.definition(tags.name), tags.variableName, tags.separator],
    color: "#f5f5f7",
  },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace,
    ],
    color: "#ffae57",
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.link,
    ],
    color: "#43e8d8",
  },
  { tag: [tags.meta, tags.comment], color: "#777b8c", fontStyle: "italic" },
  {
    tag: [tags.string, tags.special(tags.string), tags.inserted],
    color: "#a9ed70",
  },
  { tag: tags.deleted, color: "#ff6f86" },
  { tag: tags.invalid, color: "#fff", backgroundColor: "#ff426d" },
  { tag: tags.heading, color: "#ff73c4", fontWeight: "bold" },
  { tag: tags.link, color: "#35d9ff", textDecoration: "underline" },
  { tag: tags.punctuation, color: "#a89bc7" },
]);
const languageSlot = new Compartment();
let view: EditorView | null = null,
  onChange: (text: string) => void = () => {},
  languageRequest = 0,
  suppressChange = false;
function languageFor(filename) {
  const ext = (filename.toLowerCase().match(/\.([^.\/]+)$/) || [])[1] || "";
  return (
    languages.find(
      (x) => x.extensions?.includes(ext) || x.filename?.test?.(filename),
    ) || null
  );
}
async function loadLanguage(filename) {
  try {
    return (await languageFor(filename)?.load()) || [];
  } catch {
    return [];
  }
}
export async function openEditor(
  parent: HTMLElement,
  content: string,
  filename: string,
  changed?: (text: string) => void,
) {
  onChange = changed || (() => {});
  const request = ++languageRequest;
  if (!view)
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          githubDark,
          syntaxHighlighting(synthwaveHighlight),
          languageSlot.of([]),
          keymap.of([indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !suppressChange)
              onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
  else
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      effects: languageSlot.reconfigure([]),
    });
  view.focus();
  void loadLanguage(filename).then((language) => {
    if (view && request === languageRequest)
      view.dispatch({ effects: languageSlot.reconfigure(language) });
  });
  return view;
}
export function editorText() {
  return view?.state.doc.toString() || "";
}
export function replaceEditorText(content: string) {
  if (!view || view.state.doc.toString() === content) return;
  const { anchor, head } = view.state.selection.main;
  const scrollTop = view.scrollDOM.scrollTop;
  const scrollLeft = view.scrollDOM.scrollLeft;
  suppressChange = true;
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: EditorSelection.single(
        Math.min(anchor, content.length),
        Math.min(head, content.length),
      ),
    });
  } finally {
    suppressChange = false;
  }
  requestAnimationFrame(() => {
    if (!view) return;
    view.scrollDOM.scrollTop = scrollTop;
    view.scrollDOM.scrollLeft = scrollLeft;
  });
}
export function focusEditor() {
  view?.focus();
}
