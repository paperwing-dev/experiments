# Flue findings

Running notes from the Composer MVP implementation on 2026-08-24.

## Project setup

- Flue 2.0.3 uses `@flue/vite` before the official Cloudflare Vite plugin. Agent modules are discovered through the `'use agent'` directive; `app.ts` owns the route map.
- Flue 2.0.3 declares Vite 8 as a peer dependency. Starting from a typical Vite 7 scaffold fails npm's dependency resolution; current `@vitejs/plugin-react` 6 supports the required Vite 8 line.
- The installed Flue 2.0.3 runtime requires Node 22.19 or newer. The available system Node 22.7 can install with warnings but cannot be treated as supported; this repo declares the engine and includes an `.nvmrc` for Node 24.
- The installed package also requires `cloudflare({ config: flueWorkerConfig() })`. The runtime gives a useful build-time error when the customizer is missing, even though the short deployment guide still shows `cloudflare()` without it.
- npm omitted Vite 8/Rolldown's macOS ARM optional native binding on the first install. Keeping that package in `optionalDependencies` makes local installation reliable without making other platforms require it.
- The Cloudflare target requires `nodejs_compat`, a compatibility date of at least 2026-04-01, and explicit SQLite Durable Object migrations for generated agent classes.
- Restricting `flue({ providers: ['cloudflare'] })` keeps the Worker bundle focused and enables Workers AI without an application API key.

## Persistent state and tools

- `usePersistentState` is intentionally React-like, but values live in the agent conversation's Durable Object. Updater functions are safer than deriving a new value from the render snapshot.
- Flue tools return an envelope (`{ output }`). Declared output schemas validate before results become durable, structured `dynamic-tool` parts in the client transcript.
- Calling both persistent-state setters after sandbox validation worked as intended: the structured tool output reached history with revision 1, and a second turn rendered with the saved program and advanced to revision 2.
- Returning `terminate: true` with a successful tool result keeps the artwork update to one success per user prompt. A throwing execution remains available to the model for a focused repair and never reaches the state setters.

## Worker Loader and Code Mode

- `DynamicWorkerExecutor` accepts the `LOADER` Worker Loader binding directly. `globalOutbound: null` prevents generated workers from using `fetch` or raw connections.
- The executor already normalizes generated code in `@cloudflare/codemode` 0.5.1. A short timeout remains important because generated math can contain accidental infinite loops.
- The 0.5.1 executor still accepts a raw function map but logs that the form is deprecated. Passing an empty resolved-provider array for this no-tools sandbox avoids the warning and gives generated art no host capabilities.
- A local end-to-end probe successfully executed an 80-point hard-coded spiral through the real Worker Loader. No special local shim was needed once the loader binding was present.

## Client behavior

- `@flue/react` 2.0.3 needs no provider. `useFlueAgent({ url })` loads durable history and follows live updates; tool results are available on `dynamic-tool` parts with `state === 'output-available'`.
- Real local durable history preserved the validated visual object directly on the tool part. No secondary result endpoint or data channel was needed.
- The React hook moved from `Composing` to `Ready` and exposed a 141-point revision-1 tool result without client polling code. Reloading the page restored that revision from durable history and rebuilt the Three.js geometry.
- The client only renders user prompts and successful `run_visual_program` outputs; model reasoning remains in the durable stream but stays out of the primary sculpture interface.

## Testing and local development

- Vitest auto-loads `vite.config.ts` by default. A separate minimal `vitest.config.ts` prevents unit tests from starting the Cloudflare plugin/workerd or reserving an inspector port.
- Local Workers AI uses a remote binding and warns that it can incur usage. Vite's optimizer briefly missed an internal Flue provider chunk during the first full reload, then regenerated it and started normally without a config workaround.
- The second acceptance turn received several transient Workers AI `internal error` responses. Flue retried and completed the submission; revision 1 remained usable until revision 2 succeeded.
- The three-turn memory check was exact: the wild-outer-half edit kept 70/70 inner points and changed 70/70 outer points; the thinner-tube edit kept 140/140 path points and changed radius from 2 to 1.5.

## Deployment

- The generated deploy config included `FlueDesignAgent`, its SQLite Durable Object migration, Workers AI, static assets, and the `LOADER` Worker Loader binding. Wrangler deployed it without manual binding edits.
- The public executor probe returned 80 validated points through the deployed Dynamic Worker. A separate production Flue prompt settled successfully with revision 1 and 151 structured points in durable history.
- The deployed Worker is `https://composer.korinne.workers.dev` (version `cdb53e45-e1d7-4814-9e2b-670b46a52b36` after the visual-perception QA pass).

## Visual perception

- Browser Run's screenshot Quick Action was sufficient; no browser session or CDP layer was needed. The binding accepts a fixed viewport, selector readiness wait, and PNG response directly from the Flue Durable Object. `remote: true` is required for local development.
- The inspection surface reuses the exact validated `VisualResult`, carried in the URL fragment so it is never sent to the static asset server. A fixed camera, viewport, pixel ratio, material, lighting, and `data-inspection-ready` signal produce a chat-free canonical view without expanding durable artwork state.
- A `harness: true` tool feels natural for this private perception step. `harness.prompt()` accepted the Browser Run PNG through `images` and enforced the Valibot critique schema through `result`; only the critique returns to the parent agent. The same Workers AI Kimi K2.6 model handled the vision call with low thinking, so no extra provider credential was required.
- Harness scratch prompts inherit the parent tool catalog. The vision prompt therefore explicitly calls only `finish`, while the parent-owned turn state remains the authoritative limit on visual execution.
- Browser latency is available from `X-Browser-Ms-Used`, and the harness result exposes model identity and token usage. Logging those values makes the two expensive stages visible without persisting screenshot base64 or returning it to the parent agent.
- Browser, render, and vision failures are deliberately converted to a structured `unavailable` result. The current program and revision remain untouched, the parent does not retry inspection, and no correction becomes eligible.
- A Flue-specific control-flow wrinkle appeared after `run_visual_program` updated persistent current-program state: the framework emitted a `System instructions updated` advisory and the parent could settle before calling the requested inspection. A small `useAgentFinish` signal reliably resumes that pending step. Code-owned state still enforces one inspection and at most one successful correction per user message.
- The pre-execution guard matters as well as the post-execution state update. During QA, the model briefly confused earlier-turn limits with the current request and tried a correction before inspecting; checking turn state before invoking the Dynamic Worker prevents even an uncommitted speculative execution. The prompt now states explicitly that limits reset on each user message.
- Production QA confirmed selective use: an initial asymmetric/upward/negative-space request produced `run_visual_program(inspect=true) → inspect_visual`, the grounded critique returned `needsRevision=false`, and no edit followed. A 20%-thinner request then produced only `run_visual_program(inspect=false)`, preserved all 160 path points exactly, and changed radius from 3 to 2.4.
- A vague “more visually interesting without making it chaotic” edit produced one initial revision, one concrete visual critique, and exactly one critique-connected correction with no second inspection. This architecture is cleaner than a direct application-level model call for traceability and parent-agent tool use, but continuation across instruction updates required an explicit Flue lifecycle hook.

## Open questions to verify

- Whether a future Flue API should distinguish transient per-user-turn state from Durable Object state without requiring a tiny persisted state machine.

## Immutable revision history

- One `designHistory` value now owns the selected revision id, immutable source revisions, parameter-ready metadata, and the empty variation-set map. The old `currentCode` and numeric `revision` values remain read-only migration inputs and are no longer updated.
- Legacy migration runs in `useAgentStart` on the next delivery. It appends one `initial` node only while the graph is empty, so reconnects, control actions, and recovery cannot create duplicate initial revisions.
- Revision graph ergonomics in `usePersistentState` are good for this shape as long as every read-modify-write uses an updater. Migration and a later tool commit can occur in one response because the tool updater sees the start-hook write buffer rather than the older render snapshot.
- Setter updaters resolve synchronously at call time, so the agent can capture the exact next graph for its validated tool output and compact client projection. The write itself still commits atomically with the owning hook seam or tool batch.
- `run_visual_program` executes and validates generated source before any graph update. A sandbox or validation error therefore has no graph write or pointer movement. An inspection-eligible first run now stays as a persisted turn candidate: acceptance or inspection unavailability commits it once, while a requested correction discards the candidate from artifact history and commits only the corrected program. This keeps one user delivery equal to one user-facing revision without losing the internal tool trace.
- New revisions carry a durable turn id. The compact client projection recognizes pre-fix, same-instruction draft/correction pairs that lack turn ids and hides the internal draft; semantic Undo skips that legacy draft as well. Repeating the same prompt in two new deliveries still creates two distinct revisions because their turn ids differ.
- Inspection and revision selection re-execute an already-recorded source only to reproduce its `VisualResult`; those executions do not create nodes. Undo changes the pointer to the parent, Restore changes it to the selected id, and the next generated edit appends against whichever pointer is current.
- `useDataWriter` publishes a compact `data-designHistory` projection without program source and a `data-selectedVisual` result for Undo/Restore renders. This lets the React client follow `currentRevisionId` after reconnect without adding a second persistence system or storing geometry in the graph.
- React cannot directly call a `usePersistentState` setter. The small history controls send exact internal Composer messages; `useAgentStart` recognizes and applies them deterministically, while the visual-program tool rejects execution during a control delivery.
- Local end-to-end QA produced A → B → C, moved the pointer back to B, appended D from B while preserving C, restored C without copying it, and appended E with C as its parent. Undo returned to C, and a full reload restored the same pointer and all five nodes.
- An intentionally throwing generated program produced a durable `output-error` but left C selected and the graph at five revisions. The prior canvas remained visible; only the terminal showed the failed candidate for diagnosis.
- Workers AI returned several transient `internal error` responses during this QA run. Flue retried them without duplicating graph nodes or losing the selected pointer.
