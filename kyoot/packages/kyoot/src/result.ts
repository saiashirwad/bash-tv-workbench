export type FailCause<E> = { readonly _tag: "Fail"; readonly error: E };
export type DefectCause = { readonly _tag: "Defect"; readonly defect: unknown };
export type InterruptedCause = { readonly _tag: "Interrupted" };
export type Cause<E> = FailCause<E> | DefectCause | InterruptedCause;

export type Ok<A> = { readonly ok: true; readonly value: A };
export type Err<C> = { readonly ok: false; readonly cause: C };
export type Result<E, A> = Ok<A> | Err<Cause<E>>;

// Each constructor returns its own branch, so a handler that builds a Result
// from several callbacks infers a union of branches — which is a Result.
export const Result = {
  ok<A>(value: A): Ok<A> {
    return { ok: true, value };
  },
  fail<E>(error: E): Err<FailCause<E>> {
    return { ok: false, cause: { _tag: "Fail", error } };
  },
  defect(defect: unknown): Err<DefectCause> {
    return { ok: false, cause: { _tag: "Defect", defect } };
  },
  interrupted(): Err<InterruptedCause> {
    return { ok: false, cause: { _tag: "Interrupted" } };
  },
};
