// frontend/dom.ts
var $ = (selector, root = document) => root.querySelector(selector);
var $$ = (selector, root = document) => [
  ...root.querySelectorAll(selector)
];
function escapeHtml(value = "") {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]
  );
}
var encodePathPart = (value) => encodeURIComponent(value);
export {
  $,
  $$,
  encodePathPart,
  escapeHtml
};
