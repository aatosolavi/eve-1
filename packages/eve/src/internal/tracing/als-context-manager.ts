import { AsyncLocalStorage } from "node:async_hooks";

import {
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
} from "#compiled/@opentelemetry/api/index.js";

/**
 * An `AsyncLocalStorage`-backed OpenTelemetry context manager.
 *
 * eve's tool loop nests AI SDK spans under the turn span with
 * `context.with(...)`. That only propagates when a context manager is
 * registered, and eve does not vendor `@opentelemetry/context-async-hooks`, so
 * this is the minimal equivalent used by local dev trace capture. It is
 * registered globally alongside the local `TracerProvider`; without it every
 * span would be a disconnected root and the waterfall would be flat.
 */
export class AlsContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(context, () => fn.apply(thisArg as ThisParameterType<F>, args));
  }

  bind<T>(_context: Context, target: T): T {
    // Only `active()`/`with()` are exercised by eve's turn nesting; binding
    // arbitrary targets is not needed for local capture.
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}
