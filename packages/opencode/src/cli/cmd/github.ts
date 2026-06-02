import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"

export { extractResponseText, formatPromptTooLargeError, parseGitHubRemote } from "./github.shared"

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "install the GitHub agent",
  handler: () =>
    Effect.gen(function* () {
      const { githubInstall } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubInstall()
    }),
})

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "run the GitHub agent",
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub mock event to run the agent for",
      })
      .option("token", {
        type: "string",
        describe: "GitHub personal access token (github_pat_********)",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const { githubRun } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubRun(args)
    }),
})

export function buildCommentKeyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

export function buildCommentAnchor(digest: string): string {
  return `<!-- opencode:comment-key:sha256:${digest} -->`
}

export function appendCommentAnchor(body: string, digest: string): string {
  return `${body}\n${buildCommentAnchor(digest)}`
}

export function findStickyCommentIds(
  comments: Array<{ id: number; body?: string | null; user?: { login?: string | null } | null }>,
  anchor: string,
): number[] {
  return comments.filter((comment) => comment.body?.includes(anchor)).map((comment) => comment.id)
}

export const GithubCommand = cmd({
  command: "github",
  describe: "manage GitHub agent",
  builder: (yargs) => yargs.command(GithubInstallCommand).command(GithubRunCommand).demandCommand(),
  async handler() {},
})
