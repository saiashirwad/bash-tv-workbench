// frontend/auth.ts
var genericFailure = "Could not authenticate. Check your connection and try again.";
async function exchangeWorkbenchCredential(token, fetcher = fetch) {
  const response = await fetcher("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      response.status === 401 ? "That owner or collaborator credential wasn\u2019t accepted. Try again." : genericFailure
    );
  }
  if (!result.ok && !result.authenticated) throw new Error(genericFailure);
  return result;
}
async function ensureWorkbenchSession() {
  const dialog = document.querySelector("#authDialog");
  const form = document.querySelector("#authForm");
  const input = document.querySelector("#authCredential");
  const submit = document.querySelector("#authSubmit");
  const submitLabel = document.querySelector("#authSubmitLabel");
  const error = document.querySelector("#authError");
  if (!dialog || !form || !input || !submit || !submitLabel || !error)
    throw new Error("Workbench authentication interface is unavailable");
  const finish = (session) => {
    input.value = "";
    if (dialog.open) dialog.close();
    document.body.classList.remove("auth-pending");
    document.body.classList.toggle(
      "open-experimental",
      session.authenticationRequired === false
    );
    const warning = document.querySelector("#openAccessWarning");
    if (warning)
      warning.hidden = session.authenticationRequired !== false;
    return session;
  };
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const currentSession = await response.json();
    if (response.ok && currentSession.authenticated)
      return finish(currentSession);
  } catch {
    error.textContent = "Could not check the current session. Enter a credential to try again.";
  }
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const token = input.value;
      if (!token) {
        error.textContent = "Enter an owner or collaborator credential.";
        input.focus();
        return;
      }
      submit.disabled = true;
      input.disabled = true;
      form.setAttribute("aria-busy", "true");
      submitLabel.textContent = "AUTHENTICATING\u2026";
      error.textContent = "";
      try {
        const session = await exchangeWorkbenchCredential(token);
        resolve(finish(session));
      } catch (failure) {
        input.value = "";
        error.textContent = failure instanceof Error ? failure.message : genericFailure;
        input.disabled = false;
        submit.disabled = false;
        form.removeAttribute("aria-busy");
        submitLabel.textContent = "ENTER WORKBENCH";
        input.focus();
      }
    });
  });
}
export {
  ensureWorkbenchSession,
  exchangeWorkbenchCredential
};
