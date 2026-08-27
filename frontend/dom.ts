export const $ = (selector: string, root: ParentNode = document): any =>
  root.querySelector(selector);
export const $$ = (selector: string, root: ParentNode = document): any[] => [
  ...root.querySelectorAll(selector),
];

export function escapeHtml(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

export const encodePathPart = (value) => encodeURIComponent(value);
