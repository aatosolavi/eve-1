# Evals

Coding-agent evals for eve. Each eval is a small eve project, a user prompt,
and hidden assertions. The prompt runs through a coding agent in a sandbox, and
the assertions check the project it wrote.

These are different from the fixture-owned `eve eval` suites under `e2e/`.
Those exercise a running eve agent through its HTTP API. This suite evaluates
whether a coding agent can author an eve project and whether the documentation
bundled with eve improves that outcome.

## How it works

The runner is
[`@vercel/agent-eval`](https://github.com/vercel-labs/agent-eval). It copies a
fixture into a Vercel or local Docker sandbox, gives `PROMPT.md` to the coding
agent, withholds `EVAL.ts`, and then runs the grader and the fixture's `build`
script.

`evals/run.js` packs the locally built `eve` package and generates three
experiments:

- `baseline` installs the local package without agent-specific guidance.
- `agents-md` additionally writes an `AGENTS.md` that points the coding agent
  at the version-matched docs in `node_modules/eve/docs/`.
- `eve-skill` installs the repository's `skills/eve/SKILL.md` at Claude Code's
  project skill path, mirroring the skill selected by
  `npx skills add https://github.com/vercel/eve --skill eve`.

Everything else—the fixture, prompt, coding model, judge, and local eve build—is
the same. A baseline failure that becomes a treatment pass is evidence that its
documentation delivery mechanism helped.

## Writing an eval

Copy an existing fixture and take the next available number:

```sh
cp -r evals/evals/agent-000-create-greeting-tool evals/evals/agent-001-your-task
```

Edit:

- `PROMPT.md`: a realistic user goal. Describe the outcome rather than naming
  the eve API that implements it.
- `EVAL.ts`: deterministic Vitest assertions over the files the agent writes.
  Prefer source inspection; use an agentic judge only when the required behavior
  cannot be expressed reliably.
- The remaining files: a non-empty starter project for the agent to modify.

Do not commit `AGENTS.md`, `CLAUDE.md`, or other coding-agent instructions in a
fixture. The treatment must be the only variant that receives them.

Every fixture `package.json` needs a `build` script. Graders should check the
smallest observable contract that distinguishes a correct solution and allow
equivalent implementations where possible.

## Running

Build eve first. The build copies the repository docs into the package before
the runner packs it:

```sh
pnpm --filter eve build
pnpm eval agent-000-create-greeting-tool
```

The root command delegates to the private `evals` workspace package.
You can target it directly when working only on this harness:

```sh
pnpm --filter evals eval agent-000-create-greeting-tool
```

Run every fixture with `pnpm eval --all`. Preview discovery and generated
experiments without executing a coding agent with:

```sh
pnpm eval agent-000-create-greeting-tool --dry
```

Set `EVE_SKIP_PACK=1` to reuse `evals/.tarballs/eve.tgz` while iterating on a
fixture. Do not use it after changing eve code or docs.

Results and complete coding-agent transcripts are written under
`evals/results/<variant>/<timestamp>/`. The generated `experiments/`,
`.tarballs/`, and `results/` directories are ignored.

After a run, the runner prints accuracy, duration, and mean coding-model token
usage for each variant. It keeps uncached input, cache creation, cache reads,
and output separate because they have different billing characteristics. The
same counters are stored under `analysis.tokenUsage` in each `result.json`.
Judge and failure-classifier usage is not part of these coding-agent totals.

## Credentials and sandboxes

The generated experiments use the Vercel AI Gateway and select `sandbox:
'auto'`. With Vercel credentials, runs use Vercel Sandbox. Without Vercel
Sandbox access, run Docker locally and provide an `AI_GATEWAY_API_KEY` for the
configured coding model; see the `@vercel/agent-eval` documentation for current
setup.

## Layout

```text
evals/
├── package.json        # private pnpm workspace package
├── run.js              # local package packer and experiment generator
├── evals/agent-*/     # committed starter projects, prompts, and graders
├── lib/setup.ts       # installs local eve and writes treatment guidance
├── experiments/       # generated per run, ignored
├── .tarballs/         # generated local package, ignored
└── results/           # generated results and transcripts, ignored
```
