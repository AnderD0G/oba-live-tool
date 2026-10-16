import type { MockMetadata } from '../electron/main/services/mockAssistant/MockMetadata'
import type { AssistantDeskResult } from './assistantDesk'
import type { MockApiAccessStatus, MockBatch, MockRuntimeStatus } from './mockAssistant'

export type MockAssistantCommand =
  | {
      action: 'status' | 'metadata' | 'stop' | 'clear' | 'leave' | 'api-start' | 'api-stop'
      accountId: string
    }
  | { action: 'start'; accountId: string; playLocalEffects?: boolean }
  | { action: 'prepare'; accountId: string; batch: MockBatch }
export interface MockAssistantControlState {
  runtime: MockRuntimeStatus
  access: MockApiAccessStatus
}
export type MockAssistantControlResult = AssistantDeskResult<
  MockAssistantControlState | MockMetadata
>
export type AssistantSourceExpectation = { mode: 'real' } | { mode: 'mock'; runId: string }
export function matchesAssistantSource(input: unknown, mockRunId?: string): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const source = input as Record<string, unknown>
  return mockRunId === undefined
    ? source.mode === 'real' && Object.keys(source).length === 1
    : source.mode === 'mock' && source.runId === mockRunId && Object.keys(source).length === 2
}

export function validateMockAssistantCommand(input: unknown): MockAssistantCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('模拟操作参数无效')
  const value = input as Record<string, unknown>
  if (
    typeof value.accountId !== 'string' ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in IPC account identifiers.
    !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(value.accountId) ||
    ![
      'status',
      'metadata',
      'prepare',
      'start',
      'stop',
      'clear',
      'leave',
      'api-start',
      'api-stop',
    ].includes(String(value.action)) ||
    Object.keys(value).some(
      key =>
        !(
          value.action === 'prepare'
            ? ['action', 'accountId', 'batch']
            : value.action === 'start'
              ? ['action', 'accountId', 'playLocalEffects']
              : ['action', 'accountId']
        ).includes(key),
    ) ||
    (value.playLocalEffects !== undefined && typeof value.playLocalEffects !== 'boolean')
  )
    throw new Error('模拟操作参数无效')
  return value as unknown as MockAssistantCommand
}
