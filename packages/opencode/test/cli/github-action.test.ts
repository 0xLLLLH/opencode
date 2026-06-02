import { test, expect, describe } from "bun:test"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import {
  extractResponseText,
  formatPromptTooLargeError,
  buildCommentKeyDigest,
  appendCommentAnchor,
  findStickyCommentIds,
} from "../../src/cli/cmd/github"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// Helper to create minimal valid parts
function createTextPart(text: string): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "text" as const,
    text,
  }
}

function createReasoningPart(text: string): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "reasoning" as const,
    text,
    time: { start: 0 },
  }
}

function createToolPart(
  tool: string,
  title: string,
  status: "completed" | "running" = "completed",
): SessionLegacy.Part {
  if (status === "completed") {
    return {
      id: PartID.ascending(),
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      type: "tool" as const,
      callID: "c1",
      tool,
      state: {
        status: "completed",
        input: {},
        output: "",
        title,
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }
  }
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "tool" as const,
    callID: "c1",
    tool,
    state: {
      status: "running",
      input: {},
      time: { start: 0 },
    },
  }
}

function createStepStartPart(): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "step-start" as const,
  }
}

function createStepFinishPart(): SessionLegacy.Part {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    type: "step-finish" as const,
    reason: "done",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("extractResponseText", () => {
  test("returns text from text part", () => {
    const parts = [createTextPart("Hello world")]
    expect(extractResponseText(parts)).toBe("Hello world")
  })

  test("returns last text part when multiple exist", () => {
    const parts = [createTextPart("First"), createTextPart("Last")]
    expect(extractResponseText(parts)).toBe("Last")
  })

  test("returns text even when tool parts follow", () => {
    const parts = [createTextPart("I'll help with that."), createToolPart("todowrite", "3 todos")]
    expect(extractResponseText(parts)).toBe("I'll help with that.")
  })

  test("returns null for reasoning-only response (signals summary needed)", () => {
    const parts = [createReasoningPart("Let me think about this...")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for tool-only response (signals summary needed)", () => {
    // This is the exact scenario from the bug report - todowrite with no text
    const parts = [createToolPart("todowrite", "8 todos")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for multiple completed tools", () => {
    const parts = [
      createToolPart("read", "src/file.ts"),
      createToolPart("edit", "src/file.ts"),
      createToolPart("bash", "bun test"),
    ]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for running tool parts (signals summary needed)", () => {
    const parts = [createToolPart("bash", "", "running")]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("throws on empty array", () => {
    expect(() => extractResponseText([])).toThrow("no parts returned")
  })

  test("returns null for step-start only", () => {
    const parts = [createStepStartPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for step-finish only", () => {
    const parts = [createStepFinishPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for step-start and step-finish", () => {
    const parts = [createStepStartPart(), createStepFinishPart()]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns text from multi-step response", () => {
    const parts = [
      createStepStartPart(),
      createToolPart("read", "src/file.ts"),
      createTextPart("Done"),
      createStepFinishPart(),
    ]
    expect(extractResponseText(parts)).toBe("Done")
  })

  test("prefers text over reasoning when both present", () => {
    const parts = [createReasoningPart("Internal thinking..."), createTextPart("Final answer")]
    expect(extractResponseText(parts)).toBe("Final answer")
  })

  test("prefers text over tools when both present", () => {
    const parts = [createToolPart("read", "src/file.ts"), createTextPart("Here's what I found")]
    expect(extractResponseText(parts)).toBe("Here's what I found")
  })
})

describe("formatPromptTooLargeError", () => {
  test("formats error without files", () => {
    const result = formatPromptTooLargeError([])
    expect(result).toBe("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
  })

  test("formats error with files (base64 content)", () => {
    // Base64 is ~33% larger than original, so we multiply by 0.75 to get original size
    // 400 KB base64 = 300 KB original, 200 KB base64 = 150 KB original
    const files = [
      { filename: "screenshot.png", content: "a".repeat(400 * 1024) },
      { filename: "diagram.png", content: "b".repeat(200 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toStartWith("PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.")
    expect(result).toInclude("Files in prompt:")
    expect(result).toInclude("screenshot.png (300 KB)")
    expect(result).toInclude("diagram.png (150 KB)")
  })

  test("lists all files when multiple present", () => {
    // Base64 sizes: 4KB -> 3KB, 8KB -> 6KB, 12KB -> 9KB
    const files = [
      { filename: "img1.png", content: "x".repeat(4 * 1024) },
      { filename: "img2.jpg", content: "y".repeat(8 * 1024) },
      { filename: "img3.gif", content: "z".repeat(12 * 1024) },
    ]
    const result = formatPromptTooLargeError(files)

    expect(result).toInclude("img1.png (3 KB)")
    expect(result).toInclude("img2.jpg (6 KB)")
    expect(result).toInclude("img3.gif (9 KB)")
  })
})

describe("buildCommentKeyDigest", () => {
  test("returns a 64-character hex sha256 digest", () => {
    const digest = buildCommentKeyDigest("review-summary")
    expect(digest).toHaveLength(64)
    expect(digest).toMatch(/^[0-9a-f]+$/)
  })

  test("same key always produces same digest", () => {
    expect(buildCommentKeyDigest("my-key")).toBe(buildCommentKeyDigest("my-key"))
  })

  test("different keys produce different digests", () => {
    expect(buildCommentKeyDigest("key-a")).not.toBe(buildCommentKeyDigest("key-b"))
  })

  test("special characters and spaces are handled without error", () => {
    expect(() => buildCommentKeyDigest("hello world & <test> --> done")).not.toThrow()
  })

  test("empty string produces a stable digest (callers decide whether to use it)", () => {
    const digest = buildCommentKeyDigest("")
    expect(digest).toHaveLength(64)
  })
})

describe("appendCommentAnchor", () => {
  test("appends anchor on a new line at the end", () => {
    const result = appendCommentAnchor("hello", "abc123")
    expect(result).toBe("hello\n<!-- opencode:comment-key:sha256:abc123 -->")
  })

  test("anchor contains the exact digest", () => {
    const digest = buildCommentKeyDigest("review-summary")
    const result = appendCommentAnchor("body text", digest)
    expect(result).toContain(`<!-- opencode:comment-key:sha256:${digest} -->`)
  })

  test("anchor is always at the very end of the body", () => {
    const result = appendCommentAnchor("line1\nline2", "d1g3st")
    expect(result.endsWith("-->")).toBe(true)
  })

  test("body with no trailing newline gets exactly one newline before anchor", () => {
    const result = appendCommentAnchor("content", "digest")
    const parts = result.split("\n")
    expect(parts[parts.length - 1]).toBe("<!-- opencode:comment-key:sha256:digest -->")
    expect(parts[parts.length - 2]).toBe("content")
  })
})

describe("findStickyCommentIds", () => {
  test("matches comments by anchor and opencode bot author", () => {
    const ids = findStickyCommentIds(
      [
        {
          id: 1,
          user: { login: "opencode-agent[bot]" },
          body: "body\n<!-- opencode:comment-key:sha256:abc -->",
        },
      ],
      "<!-- opencode:comment-key:sha256:abc -->",
      ["opencode-agent[bot]"],
    )

    expect(ids).toEqual([1])
  })

  test("matches comments by anchor and github-actions bot author", () => {
    const ids = findStickyCommentIds(
      [
        {
          id: 2,
          user: { login: "github-actions[bot]" },
          body: "body\n<!-- opencode:comment-key:sha256:abc -->",
        },
      ],
      "<!-- opencode:comment-key:sha256:abc -->",
      ["opencode-agent[bot]", "github-actions[bot]"],
    )

    expect(ids).toEqual([2])
  })

  test("does not match comments from other authors", () => {
    const ids = findStickyCommentIds(
      [
        {
          id: 3,
          user: { login: "someone-else" },
          body: "body\n<!-- opencode:comment-key:sha256:abc -->",
        },
      ],
      "<!-- opencode:comment-key:sha256:abc -->",
      ["opencode-agent[bot]", "github-actions[bot]"],
    )

    expect(ids).toEqual([])
  })

  test("returns matching ids in API order", () => {
    const ids = findStickyCommentIds(
      [
        {
          id: 4,
          user: { login: "github-actions[bot]" },
          body: "body\n<!-- opencode:comment-key:sha256:abc -->",
        },
        {
          id: 5,
          user: { login: "github-actions[bot]" },
          body: "body\n<!-- opencode:comment-key:sha256:abc -->",
        },
      ],
      "<!-- opencode:comment-key:sha256:abc -->",
      ["github-actions[bot]"],
    )

    expect(ids).toEqual([4, 5])
  })
})
