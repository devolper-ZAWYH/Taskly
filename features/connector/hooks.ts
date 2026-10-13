"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { disconnectClaude, getClaudeSetup } from "@/lib/api/connector"

export const CLAUDE_SETUP_KEY = ["claude", "setup"] as const

/**
 * Settings → Set up MCP. Refetched when the tab regains focus, so after
 * someone clicks Allow in Claude and comes back, it already says Connected.
 */
export function useClaudeSetup() {
  return useQuery({
    queryKey: CLAUDE_SETUP_KEY,
    queryFn: getClaudeSetup,
    refetchOnWindowFocus: true,
  })
}

export function useDisconnectClaude() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: disconnectClaude,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CLAUDE_SETUP_KEY }),
  })
}
