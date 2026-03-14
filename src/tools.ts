/**
 * Tool definitions for opencode-handoff plugin.
 *
 * Factory functions that create tool definitions with injected dependencies:
 * - HandoffSession: Create a new session with handoff prompt
 * - ReadSession: Read conversation transcript from a session
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export type OpencodeClient = PluginInput["client"]

/**
 * Create the handoff_session tool.
 *
 * Takes the OpenCode client and server context as dependencies for session operations.
 * Uses server-side session APIs so the tool works with both the TUI and web frontends.
 */
export const HandoffSession = (client: OpencodeClient, serverUrl: URL, directory: string) => {
  return tool({
    description: "Create a new session with the handoff prompt and start working on it",
    args: {
      prompt: tool.schema.string().describe("The generated handoff prompt"),
      files: tool.schema.array(tool.schema.string()).optional().describe("Array of file paths to load into the new session's context"),
    },
    async execute(args, context) {
      const sessionReference = `Continuing work from session ${context.sessionID}. When you lack specific information you can use read_session to get it.`
      const fileRefs = args.files?.length
        ? args.files.map(f => `@${f.replace(/^@/, '')}`).join(' ')
        : ''
      const fullPrompt = fileRefs
        ? `${sessionReference}\n\n${fileRefs}\n\n${args.prompt}`
        : `${sessionReference}\n\n${args.prompt}`

      // Create a new session via the server API (works with all frontends)
      const session = await client.session.create({ body: {} })
      const sessionID = session.data!.id

      // Send the handoff prompt and trigger AI response
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: fullPrompt }],
        },
      })

      // Best-effort: show a toast notification if a frontend supports it
      try {
        await client.tui.showToast({
          body: {
            title: "Handoff Ready",
            message: "New session created with handoff prompt",
            variant: "success",
            duration: 4000,
          }
        })
      } catch {
        // Silently ignore — toast is a nice-to-have, not critical
      }

      // Build a direct link to the new session in the web UI
      const dirSlug = btoa(directory)
      const sessionUrl = new URL(`/${dirSlug}/session/${sessionID}`, serverUrl).toString()

      return `Handoff session created: [${sessionID}](${sessionUrl})`
    }
  })
}

/**
 * Format a conversation transcript for display.
 *
 * @param messages - Array of messages from session.messages()
 * @param limit - Optional limit to indicate if results are truncated
 * @returns Formatted transcript with user/assistant sections
 */
function formatTranscript(
  messages: Array<{ info: any; parts: any[] }>,
  limit?: number
): string {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.info.role === "user") {
      lines.push("## User")
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored) {
          lines.push(part.text)
        }
        if (part.type === "file") {
          lines.push(`[Attached: ${part.filename || "file"}]`)
        }
      }
      lines.push("")
    }

    if (msg.info.role === "assistant") {
      lines.push("## Assistant")
      for (const part of msg.parts) {
        if (part.type === "text") {
          lines.push(part.text)
        }
        if (part.type === "tool" && part.state.status === "completed") {
          lines.push(`[Tool: ${part.tool}] ${part.state.title}`)
        }
      }
      lines.push("")
    }
  }

  const output = lines.join("\n").trim()

  if (messages.length >= (limit ?? 100)) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
  }

  return output + `\n\n(End of session - ${messages.length} messages)`
}

/**
 * Create the read_session tool.
 *
 * Takes the OpenCode client as a dependency for session.messages() calls.
 */
export const ReadSession = (client: OpencodeClient) => {
  return tool({
    description: "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
    args: {
      sessionID: tool.schema.string().describe("The full session ID (e.g., sess_01jxyz...)"),
      limit: tool.schema.number().optional().describe("Maximum number of messages to read (defaults to 100, max 500)"),
    },
    async execute(args) {
      const limit = Math.min(args.limit ?? 100, 500)

      try {
        const response = await client.session.messages({
          path: { id: args.sessionID },
          query: { limit }
        })

        if (!response.data || response.data.length === 0) {
          return "Session has no messages or does not exist."
        }

        return formatTranscript(response.data, limit)
      } catch (error) {
        return `Could not read session ${args.sessionID}: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    }
  })
}
