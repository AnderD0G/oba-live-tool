import type { AnalysisAction } from './analysisRoom'
export const ANALYSIS_COMMAND_ROUTES: ReadonlyArray<{
  action: AnalysisAction
  method: 'GET' | 'POST' | 'PUT'
  path: string
  summary: string
}>
export const ANALYSIS_TOOLS: ReadonlyArray<{
  name: string
  description: string
  inputSchema: Record<string, any>
}>
export function analysisToolRoute(
  name: string,
): (typeof ANALYSIS_COMMAND_ROUTES)[number] | undefined
export function validateAnalysisTool(
  name: string,
  args: unknown,
): (typeof ANALYSIS_COMMAND_ROUTES)[number]
