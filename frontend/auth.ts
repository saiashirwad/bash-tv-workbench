type Fetcher = typeof fetch;
type AuthResult = {
  ok?: boolean;
  authenticated?: boolean;
  role?: string;
  authenticationRequired?: boolean;
};

const genericFailure =
  "Could not authenticate. Check your connection and try again.";

export async function exchangeWorkbenchCredential(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<AuthResult> {
  const response = await fetcher("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const result = (await response.json().catch(() => ({}))) as AuthResult;
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "That owner or collaborator credential wasn’t accepted. Try again."
        : genericFailure,
    );
  }
  if (!result.ok && !result.authenticated) throw new Error(genericFailure);
  return result;
}

export async function ensureWorkbenchSession() {
  const dialog = document.querySelector<HTMLDialogElement>("#authDialog");
  const form = document.querySelector<HTMLFormElement>("#authForm");
  const input = document.querySelector<HTMLInputElement>("#authCredential");
  const submit = document.querySelector<HTMLButtonElement>("#authSubmit");
  const submitLabel = document.querySelector<HTMLElement>("#authSubmitLabel");
  const error = document.querySelector<HTMLElement>("#authError");
  if (!dialog || !form || !input || !submit || !submitLabel || !error)
    throw new Error("Workbench authentication interface is unavailable");

  const finish = (session: AuthResult) => {
    input.value = "";
    if (dialog.open) dialog.close();
    document.body.classList.remove("auth-pending");
    document.body.classList.toggle(
      "open-experimental",
      session.authenticationRequired === false,
    );
    const warning = document.querySelector<HTMLElement>("#openAccessWarning");
    if (warning)
      warning.hidden = session.authenticationRequired !== false;
    return session;
  };

  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const currentSession = (await response.json()) as AuthResult;
    if (response.ok && currentSession.authenticated)
      return finish(currentSession);
  } catch {
    error.textContent =
      "Could not check the current session. Enter a credential to try again.";
  }

  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.showModal();
  input.focus();

  return new Promise<AuthResult>((resolve) => {
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
      submitLabel.textContent = "AUTHENTICATING…";
      error.textContent = "";
      try {
        const session = await exchangeWorkbenchCredential(token);
        resolve(finish(session));
      } catch (failure) {
        input.value = "";
        error.textContent =
          failure instanceof Error ? failure.message : genericFailure;
        input.disabled = false;
        submit.disabled = false;
        form.removeAttribute("aria-busy");
        submitLabel.textContent = "ENTER WORKBENCH";
        input.focus();
      }
    });
  });
}
