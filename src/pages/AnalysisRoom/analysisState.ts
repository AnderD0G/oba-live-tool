import type {
  AnalysisAction,
  AnalysisCapabilities,
  AnalysisChanged,
  AnalysisHealth,
  AnalysisPage,
  AnalysisRecord,
  AnalysisResponse,
  AnalysisScope,
  AnalysisSession,
  FieldSummary,
  ReanalysisJob,
  ReanalysisPage,
} from '../../../shared/analysisRoom'
import type {
  AttributeDictionaryDraft,
  DictionaryPreview,
  DictionaryState,
  ParsedAttributeValue,
  PublishedAttributeDictionary,
} from '../../../shared/audienceAttributes'
import type { AudienceGroupsConfig, GroupPreview, GroupState } from '../../../shared/audienceGroups'

export type AnalysisTab = 'records' | 'dictionary' | 'groups'
export interface AnalysisViewState {
  scope: AnalysisScope
  generation: number
  tab: AnalysisTab
  pending: Partial<Record<AnalysisAction, number>>
  pendingEdits: Partial<Record<AnalysisAction, number>>
  dictionaryEdit: number
  groupEdit: number
  dictionaryBaseRevision?: number
  groupsBaseRevision?: number
  dictionaryStale?: boolean
  groupsStale?: boolean
  capabilities?: AnalysisCapabilities
  session?: AnalysisSession
  sessions?: AnalysisPage<AnalysisSession>
  selectedSessionId?: string
  records?: AnalysisPage<AnalysisRecord>
  fields?: FieldSummary
  dictionary?: DictionaryState
  dictionaryDraft?: AttributeDictionaryDraft
  historicalDictionary?: PublishedAttributeDictionary
  dictionaryRollbackFromVersion?: number
  dictionaryPreview?: DictionaryPreview
  groups?: GroupState
  groupsDraft?: AudienceGroupsConfig
  groupsPreview?: GroupPreview
  reanalysis?: ReanalysisJob
  results?: ReanalysisPage
  samples: string[]
  error?: Extract<AnalysisResponse, { ok: false }>
  health?: AnalysisHealth
  reloadDictionary: boolean
  reloadGroups: boolean
}
export function createAnalysisState(scope: AnalysisScope, generation = 1): AnalysisViewState {
  return {
    scope,
    generation,
    tab: 'records',
    pending: {},
    pendingEdits: {},
    dictionaryEdit: 0,
    groupEdit: 0,
    samples: [],
    reloadDictionary: false,
    reloadGroups: false,
  }
}
export function displayAttribute(
  fact: ParsedAttributeValue | { status: 'conflict'; reason: string },
): string {
  return fact.status === 'known'
    ? String(fact.value)
    : `${fact.status === 'conflict' ? '冲突' : '未知'}（${fact.reason}）`
}
type RequestEvent = {
  accountId: string
  generation: number
  action: AnalysisAction
  requestId: number
}
export type AnalysisViewEvent =
  | { type: 'scope'; scope: AnalysisScope; generation: number }
  | { type: 'tab'; tab: AnalysisTab }
  | { type: 'dismiss-error' }
  | { type: 'select-session'; sessionId: string }
  | {
      type: 'dictionary-draft'
      draft: AttributeDictionaryDraft
      reconcile?: boolean
      rollbackFromVersion?: number
    }
  | { type: 'groups-draft'; config: AudienceGroupsConfig; reconcile?: boolean }
  | ({ type: 'begin' } & RequestEvent)
  | ({ type: 'response'; response: AnalysisResponse } & RequestEvent)
  | { type: 'changed'; generation: number; change: AnalysisChanged }
export function sameAnalysisScope(a: AnalysisScope, b: AnalysisScope): boolean {
  return a.accountId === b.accountId && a.platform === b.platform && a.source === b.source
}
function mergeSession(current?: AnalysisSession, incoming?: AnalysisSession): AnalysisSession | undefined {
  if (!incoming) return current
  if (current && incoming.createdAt < current.createdAt) return current
  if (
    current?.id === incoming.id &&
    current.status !== 'collecting' && current.status !== 'stopping' &&
    (incoming.status === 'collecting' || incoming.status === 'stopping')
  ) return current
  return incoming
}
export function reduceAnalysisState(
  state: AnalysisViewState,
  event: AnalysisViewEvent,
): AnalysisViewState {
  if (event.type === 'scope')
    return { ...createAnalysisState(event.scope, event.generation), tab: state.tab }
  if (event.type === 'tab') return { ...state, tab: event.tab }
  if (event.type === 'dismiss-error') return { ...state, error: undefined }
  if (event.type === 'select-session') {
    const pending = { ...state.pending }
    delete pending['mapping-preview']
    delete pending.records
    delete pending.fields
    delete pending.results
    delete pending.reanalyze
    return {
      ...state,
      pending,
      selectedSessionId: event.sessionId,
      records: undefined,
      fields: undefined,
      dictionaryPreview: undefined,
      results: undefined,
      reanalysis: undefined,
    }
  }
  if (event.type === 'dictionary-draft') {
    const pending = { ...state.pending }
    delete pending['mapping-preview']
    return {
      ...state,
      pending,
      dictionaryEdit: state.dictionaryEdit + 1,
      dictionaryBaseRevision: event.reconcile
        ? state.dictionary?.revision
        : (state.dictionaryBaseRevision ?? state.dictionary?.revision),
      dictionaryStale: event.reconcile ? false : state.dictionaryStale,
      dictionaryDraft: event.draft,
      dictionaryRollbackFromVersion: event.rollbackFromVersion,
      dictionaryPreview: undefined,
      groupsPreview: undefined,
    }
  }
  if (event.type === 'groups-draft') {
    const pending = { ...state.pending }
    delete pending['groups-simulate']
    return {
      ...state,
      pending,
      groupEdit: state.groupEdit + 1,
      groupsBaseRevision: event.reconcile
        ? state.groups?.revision
        : (state.groupsBaseRevision ?? state.groups?.revision),
      groupsStale: event.reconcile ? false : state.groupsStale,
      groupsDraft: event.config,
      groupsPreview: undefined,
    }
  }
  if (event.generation !== state.generation) return state
  if (event.type === 'changed') {
    if (
      event.change.accountId !== state.scope.accountId ||
      (event.change.scope && !sameAnalysisScope(event.change.scope, state.scope))
    )
      return state
    return {
      ...state,
      session: mergeSession(state.session, event.change.session),
      samples: event.change.samples.slice(-10),
      health: event.change.health ?? state.health,
      reanalysis:
        event.change.reanalysis?.id === state.reanalysis?.id
          ? event.change.reanalysis
          : state.reanalysis,
      error: event.change.error
        ? {
            ok: false,
            error: {
              code: event.change.error,
              message: '分析后台保存异常；已保留证据，请重新读取状态',
              retryable: false,
            },
            traceId: 'background-storage',
          }
        : state.error,
      reloadDictionary:
        state.reloadDictionary ||
        (event.change.dictionaryRevision !== undefined &&
          event.change.dictionaryRevision !== state.dictionary?.revision),
      reloadGroups:
        state.reloadGroups ||
        (event.change.interactionRevision !== undefined &&
          event.change.interactionRevision !== state.groups?.revision),
      ...(event.change.dictionaryRevision !== undefined ? { dictionaryPreview: undefined } : {}),
      ...(event.change.interactionRevision !== undefined ? { groupsPreview: undefined } : {}),
    }
  }
  if (event.accountId !== state.scope.accountId) return state
  if (event.type === 'begin')
    return {
      ...state,
      error: [
        'start',
        'stop',
        'mapping-draft',
        'mapping-preview',
        'mapping-publish',
        'reanalyze',
        'groups-simulate',
        'groups-apply',
      ].includes(event.action)
        ? undefined
        : state.error,
      pending: { ...state.pending, [event.action]: event.requestId },
      pendingEdits: {
        ...state.pendingEdits,
        [event.action]: event.action.startsWith('groups-') ? state.groupEdit : state.dictionaryEdit,
      },
    }
  if (state.pending[event.action] !== event.requestId) return state
  const pending = { ...state.pending }
  delete pending[event.action]
  const next = { ...state, pending, health: event.response.health ?? state.health }
  if (!event.response.ok) {
    const code = event.response.error.code
    return {
      ...next,
      error: event.response,
      reloadDictionary:
        state.reloadDictionary ||
        code === 'MAPPING_REVISION_CONFLICT' ||
        code === 'MAPPING_PREVIEW_STALE',
      reloadGroups:
        state.reloadGroups || code === 'GROUP_REVISION_CONFLICT' || code === 'GROUP_PREVIEW_STALE',
      dictionaryPreview: undefined,
      groupsPreview: undefined,
    }
  }
  const data = event.response.data
  if (
    ['mappings', 'mapping-draft', 'mapping-publish'].includes(event.action) &&
    (data as DictionaryState).revision < (state.dictionary?.revision ?? 0)
  )
    return next
  if (
    ['groups-get', 'groups-apply'].includes(event.action) &&
    (data as GroupState).revision < (state.groups?.revision ?? 0)
  )
    return next
  switch (event.action) {
    case 'capabilities':
      return {
        ...next,
        capabilities: data as AnalysisCapabilities,
        session: mergeSession(state.session, (data as AnalysisCapabilities).activeSession),
      }
    case 'start':
    case 'stop':
      return { ...next, session: mergeSession(state.session, data as AnalysisSession) }
    case 'sessions':
      return {
        ...next,
        sessions: data as AnalysisPage<AnalysisSession>,
        session: mergeSession(state.session,
          (data as AnalysisPage<AnalysisSession>).items.find(
            session => session.id === state.session?.id,
          )),
      }
    case 'records':
      return { ...next, records: data as AnalysisPage<AnalysisRecord> }
    case 'fields':
      return { ...next, fields: data as FieldSummary }
    case 'mappings': {
      const current = data as DictionaryState
      if (current.selectedVersion) return { ...next, historicalDictionary: current.selectedVersion }
      const edited =
        state.dictionaryDraft !== undefined &&
        JSON.stringify(state.dictionaryDraft) !== JSON.stringify(state.dictionary?.draft)
      const base = edited
        ? (state.dictionaryBaseRevision ?? state.dictionary?.revision ?? current.revision)
        : current.revision
      return {
        ...next,
        dictionary: current,
        dictionaryDraft: edited ? state.dictionaryDraft : current.draft,
        dictionaryBaseRevision: base,
        dictionaryStale: base !== current.revision,
        dictionaryPreview: undefined,
        reloadDictionary: false,
      }
    }
    case 'mapping-draft':
    case 'mapping-publish':
      return {
        ...next,
        dictionary: data as DictionaryState,
        dictionaryBaseRevision: (data as DictionaryState).revision,
        dictionaryStale: false,
        dictionaryDraft:
          state.pendingEdits[event.action] === state.dictionaryEdit
            ? (data as DictionaryState).draft
            : state.dictionaryDraft,
        dictionaryPreview: undefined,
        groupsPreview: undefined,
        reloadDictionary: false,
      }
    case 'mapping-preview':
      return { ...next, dictionaryPreview: data as DictionaryPreview }
    case 'groups-get': {
      const current = data as GroupState
      const edited =
        state.groupsDraft !== undefined &&
        JSON.stringify(state.groupsDraft) !== JSON.stringify(state.groups?.config)
      const base = edited
        ? (state.groupsBaseRevision ?? state.groups?.revision ?? current.revision)
        : current.revision
      return {
        ...next,
        groups: current,
        groupsDraft: edited ? state.groupsDraft : current.config,
        groupsBaseRevision: base,
        groupsStale: base !== current.revision,
        groupsPreview: undefined,
        reloadGroups: false,
      }
    }
    case 'groups-apply':
      return {
        ...next,
        groups: data as GroupState,
        groupsBaseRevision: (data as GroupState).revision,
        groupsStale: false,
        groupsDraft:
          state.pendingEdits[event.action] === state.groupEdit
            ? (data as GroupState).config
            : state.groupsDraft,
        groupsPreview: undefined,
        reloadGroups: false,
      }
    case 'groups-simulate':
      return { ...next, groupsPreview: data as GroupPreview }
    case 'reanalyze':
      return { ...next, reanalysis: data as ReanalysisJob, results: undefined }
    case 'results':
      return { ...next, results: data as ReanalysisPage, reanalysis: (data as ReanalysisPage).job }
  }
}
