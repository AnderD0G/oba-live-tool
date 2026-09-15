import type { CaptureRecord } from './commentCatcher'
export interface PrintTicket {
  id: string
  number: string
  sourceId: string
  record: CaptureRecord
  status: 'queued' | 'submitting' | 'submitted' | 'failed' | 'uncertain'
  error: string
  createdAt: number
}
export interface PrintState {
  tickets: PrintTicket[]
  autoQueue: boolean
  automatic: { printer: string; paper: '40x30' | 'A4' | '80mm' | '58mm' } | null
  error: string
}
export type TicketCommand =
  | { action: 'state' }
  | { action: 'enqueue'; records: CaptureRecord[] }
  | { action: 'autoQueue'; enabled: boolean }
  | {
      action: 'automatic'
      enabled: boolean
      printer: string
      paper: '40x30' | 'A4' | '80mm' | '58mm'
    }
  | { action: 'reset'; id: string }
  | { action: 'preview'; ids: string[]; paper: '40x30' | 'A4' | '80mm' | '58mm' }
  | { action: 'print'; ids: string[]; printer: string; paper: '40x30' | 'A4' | '80mm' | '58mm' }
  | { action: 'printers' }
export type TicketResponse =
  | { ok: true; state?: PrintState; printers?: { name: string; displayName: string }[] }
  | { ok: false; error: string }
