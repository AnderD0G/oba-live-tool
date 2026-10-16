import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { AnalysisRoomController } from '@/hooks/useAnalysisRoom'
import type { FieldEntry } from '../../../shared/analysisRoom'
import { validateAnalysisTool } from '../../../shared/analysisRoomContract.mjs'
import type {
  AttributeDefinition,
  AttributeDictionaryDraft,
  AttributeType,
} from '../../../shared/audienceAttributes'
import { displayAttribute } from './analysisState'
import { editBasicDefinition } from './dictionaryEditor'

export default function DictionaryTab({
  room,
  field,
}: {
  room: AnalysisRoomController
  field?: FieldEntry
}) {
  const { state, dispatch, request } = room
  const draft = state.dictionaryDraft
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [attributePath, setAttributePath] = useState('')
  const [type, setType] = useState<AttributeType>('string')
  const [semantic, setSemantic] = useState<AttributeDefinition['semantic']>('basic')
  const [ttl, setTtl] = useState('86400')
  const [editor, setEditor] = useState('')
  const [localError, setLocalError] = useState('')
  const [historicalVersion, setHistoricalVersion] = useState('')
  useEffect(() => {
    if (!field) return
    setAttributePath(field.path)
    setId(
      field.path
        .split('/')
        .pop()
        ?.replace(/[^A-Za-z0-9_.-]/g, '')
        .replace(/^[^A-Za-z]+/, '') || 'attribute',
    )
    setName('')
    setType(
      field.types.includes('number')
        ? 'number'
        : field.types.includes('boolean')
          ? 'boolean'
          : 'string',
    )
  }, [field])
  useEffect(() => {
    if (draft) setEditor(JSON.stringify(draft, null, 2))
  }, [draft])
  const update = (next: AttributeDictionaryDraft) => {
    dispatch({ type: 'dictionary-draft', draft: next })
    setLocalError('')
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.dictionary?.draft)
  const selected = state.sessions?.items.find(s => s.id === state.selectedSessionId)
  const previewAllowed =
    !!selected &&
    selected.status !== 'collecting' &&
    selected.status !== 'stopping' &&
    selected.counters.saved > 0 &&
    !dirty
  const mappingScope = { platform: state.scope.platform, source: state.scope.source }
  if (!draft || !state.dictionary) return <p role="status">正在读取属性字典…</p>
  return (
    <section className="space-y-4 min-w-0" aria-label="属性字典内容">
      <div className="flex flex-wrap gap-3 text-sm">
        <span>当前发布版本：{state.dictionary.activeVersion ?? '未发布'}</span>
        <span>编辑修订：{state.dictionary.revision}</span>
        <span>{dirty ? '有未保存改动' : '草稿已同步'}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        同平台、同来源共用字典。先保存草稿，再用已停止的记录预览，最后发布新版本。购买、退款等行为属性目前仅预留，不从等级推断。
      </p>
      <section className="border rounded p-3 space-y-2 text-sm" aria-label="字典历史版本">
        <label htmlFor="analysis-historical-version">
          查看历史版本（当前 {state.dictionary.activeVersion ?? '未发布'}）
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="analysis-historical-version"
            type="number"
            min={1}
            value={historicalVersion}
            onChange={e => setHistoricalVersion(e.target.value)}
            className="max-w-40"
          />
          <Button
            variant="outline"
            disabled={
              !Number.isSafeInteger(Number(historicalVersion)) ||
              Number(historicalVersion) < 1 ||
              !!state.pending.mappings
            }
            onClick={() =>
              void request({
                action: 'mappings',
                params: { ...mappingScope, version: Number(historicalVersion) },
              })
            }
          >
            读取版本内容
          </Button>
        </div>
        {state.historicalDictionary && (
          <>
            <p>不可变版本 {state.historicalDictionary.version}；读取不会修改当前草稿或运行版本。</p>
            <pre className="text-xs whitespace-pre-wrap break-all max-h-60 overflow-auto">
              {JSON.stringify(state.historicalDictionary, null, 2)}
            </pre>
            <Button
              variant="outline"
              disabled={state.dictionaryStale}
              onClick={() => {
                const old = state.historicalDictionary!
                dispatch({
                  type: 'dictionary-draft',
                  draft: {
                    identity: structuredClone(old.identity),
                    definitions: structuredClone(old.definitions),
                    acceptedFormatVersions: [...old.acceptedFormatVersions],
                  },
                  rollbackFromVersion: old.version,
                })
              }}
            >
              加载此版本为回退草稿
            </Button>
            <p>回退仍须保存草稿、真实样本预览、发布为新版本；不会覆盖旧版本。</p>
          </>
        )}
      </section>
      <div className="grid sm:grid-cols-2 gap-3">
        <label htmlFor="analysis-user-id-path" className="text-sm space-y-1">
          用户 ID 路径
          <Input
            id="analysis-user-id-path"
            value={draft.identity.userIdPath}
            onChange={e =>
              update({ ...draft, identity: { ...draft.identity, userIdPath: e.target.value } })
            }
          />
        </label>
        <label htmlFor="analysis-nickname-path" className="text-sm space-y-1">
          昵称路径
          <Input
            id="analysis-nickname-path"
            value={draft.identity.nicknamePath ?? ''}
            onChange={e =>
              update({
                ...draft,
                identity: { ...draft.identity, nicknamePath: e.target.value || undefined },
              })
            }
          />
        </label>
      </div>
      {field && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              update({ ...draft, identity: { ...draft.identity, userIdPath: field.path } })
            }
          >
            将选中字段设为用户 ID
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              update({ ...draft, identity: { ...draft.identity, nicknamePath: field.path } })
            }
          >
            将选中字段设为昵称
          </Button>
        </div>
      )}
      <fieldset className="border rounded-lg p-3 space-y-3 min-w-0">
        <legend className="px-1 font-medium">定义属性</legend>
        <div className="grid sm:grid-cols-2 gap-3">
          <label htmlFor="analysis-attribute-id" className="text-sm space-y-1">
            属性标识
            <Input
              id="analysis-attribute-id"
              value={id}
              maxLength={64}
              placeholder="level"
              onChange={e => setId(e.target.value)}
            />
          </label>
          <label htmlFor="analysis-attribute-name" className="text-sm space-y-1">
            属性名称
            <Input
              id="analysis-attribute-name"
              value={name}
              maxLength={128}
              placeholder="用户级别"
              onChange={e => setName(e.target.value)}
            />
          </label>
          <label htmlFor="analysis-attribute-path" className="text-sm space-y-1 sm:col-span-2">
            属性路径
            <Input
              id="analysis-attribute-path"
              value={attributePath}
              onChange={e => setAttributePath(e.target.value)}
            />
          </label>
          <label className="text-sm space-y-1">
            属性类型
            <select
              className="w-full border rounded p-2 bg-background"
              value={type}
              onChange={e => setType(e.target.value as AttributeType)}
            >
              {['string', 'number', 'integer', 'boolean', 'enum'].map(t => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="text-sm space-y-1">
            属性用途
            <select
              className="w-full border rounded p-2 bg-background"
              value={semantic}
              onChange={e => {
                setSemantic(e.target.value as AttributeDefinition['semantic'])
                setTtl(e.target.value === 'follow' ? '300' : '86400')
              }}
            >
              <option value="basic">基本属性</option>
              <option value="follow">关注状态</option>
              <option value="behavior-reserved">行为属性（预留，不参与推断）</option>
            </select>
          </label>
          <label htmlFor="analysis-attribute-ttl" className="text-sm space-y-1">
            有效期（秒）
            <Input
              id="analysis-attribute-ttl"
              type="number"
              min={1}
              max={2592000}
              value={ttl}
              onChange={e => setTtl(e.target.value)}
            />
          </label>
        </div>
        <Button
          onClick={() => {
            if (
              !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id) ||
              !name.trim() ||
              !attributePath.startsWith('/') ||
              !Number.isFinite(Number(ttl)) ||
              Number(ttl) < 1 ||
              Number(ttl) > 2592000
            ) {
              setLocalError('请填写有效的属性标识、名称、JSON 路径与有效期')
              return
            }
            if (type === 'enum') {
              setLocalError('枚举需要在下方高级编辑中填写 enumValues 后保存')
              return
            }
            try {
              update(
                editBasicDefinition(draft, {
                  id,
                  name: name.trim(),
                  type,
                  semantic,
                  ttlMs: Number(ttl) * 1000,
                  path: attributePath,
                }),
              )
            } catch (error) {
              setLocalError(error instanceof Error ? error.message : '请检查高级映射')
            }
          }}
        >
          加入草稿
        </Button>
      </fieldset>
      <div className="space-y-2">
        {draft.definitions.map(def => (
          <div
            className="border rounded p-2 flex flex-wrap items-center gap-2 text-sm"
            key={def.id}
          >
            <div className="flex-1 min-w-0">
              <p>{def.name}</p>
              <p className="text-xs text-muted-foreground break-all">
                {def.id} · {def.type} · {def.candidates.map(c => c.path).join(', ')} ·{' '}
                {def.semantic}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setId(def.id)
                setName(def.name)
                setAttributePath(def.candidates[0]?.path ?? '')
                setType(def.type)
                setSemantic(def.semantic)
                setTtl(String((def.ttlMs ?? 86400000) / 1000))
              }}
            >
              编辑
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                update({ ...draft, definitions: draft.definitions.filter(d => d.id !== def.id) })
              }
            >
              移出草稿
            </Button>
          </div>
        ))}
      </div>
      <details className="border rounded p-3">
        <summary className="cursor-pointer text-sm">
          高级编辑：多路径、枚举、转换表、格式版本
        </summary>
        <Textarea
          aria-label="字典高级 JSON"
          className="font-mono text-xs mt-2 min-h-40"
          value={editor}
          onChange={e => setEditor(e.target.value)}
          maxLength={524288}
        />
        <Button
          className="mt-2"
          variant="outline"
          onClick={() => {
            try {
              const next = JSON.parse(editor)
              validateAnalysisTool('analysis_mapping_draft', {
                ...mappingScope,
                revision: state.dictionary!.revision,
                draft: next,
              })
              update(next)
            } catch {
              setLocalError('字典 JSON 无效；当前草稿未替换')
            }
          }}
        >
          更新本地字典草稿
        </Button>
      </details>
      {dirty && (
        <details className="border rounded p-3">
          <summary className="cursor-pointer text-sm">
            比较服务端草稿（修订 {state.dictionary.revision}）
          </summary>
          <pre className="text-xs whitespace-pre-wrap break-all max-h-56 overflow-auto">
            {JSON.stringify(state.dictionary.draft, null, 2)}
          </pre>
        </details>
      )}
      {localError && (
        <p role="alert" className="text-sm text-red-700">
          {localError}
        </p>
      )}
      {state.dictionaryStale && (
        <section role="alert" className="border rounded p-3 space-y-2">
          <p>
            服务端已更新；本地草稿仍基于修订 {state.dictionaryBaseRevision}
            。请先比较并明确选择，不会自动覆盖新配置。
          </p>
          <Button
            variant="outline"
            onClick={() =>
              dispatch({
                type: 'dictionary-draft',
                draft: state.dictionary!.draft,
                reconcile: true,
              })
            }
          >
            采用服务端草稿
          </Button>
          <Button
            variant="outline"
            onClick={() => dispatch({ type: 'dictionary-draft', draft, reconcile: true })}
          >
            已比较，继续使用本地草稿
          </Button>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={state.dictionaryStale || !!state.pending['mapping-draft']}
          onClick={() =>
            void request({
              action: 'mapping-draft',
              params: {
                ...mappingScope,
                revision: state.dictionaryBaseRevision ?? state.dictionary!.revision,
                draft,
              },
            })
          }
        >
          保存字典草稿
        </Button>
        <Button
          variant="outline"
          disabled={
            !previewAllowed ||
            state.dictionaryStale ||
            !!state.pending['mapping-preview'] ||
            !!state.pending['mapping-draft']
          }
          onClick={() =>
            void request({
              action: 'mapping-preview',
              params: {
                ...mappingScope,
                accountId: state.scope.accountId,
                revision: state.dictionary!.revision,
                sessionId: state.selectedSessionId!,
              },
            })
          }
        >
          预览样本
        </Button>
        <Button
          disabled={
            dirty ||
            state.dictionaryStale ||
            !state.dictionaryPreview ||
            state.dictionaryPreview.expiresAt <= Date.now() ||
            !!state.pending['mapping-publish']
          }
          onClick={() =>
            void request({
              action: 'mapping-publish',
              params: {
                ...mappingScope,
                revision: state.dictionary!.revision,
                previewToken: state.dictionaryPreview!.token,
                ...(state.dictionaryRollbackFromVersion
                  ? { rollbackFromVersion: state.dictionaryRollbackFromVersion }
                  : {}),
              },
            })
          }
        >
          {state.dictionaryRollbackFromVersion
            ? `发布回退新版本（来源 ${state.dictionaryRollbackFromVersion}）`
            : '发布新版本'}
        </Button>
      </div>
      {!previewAllowed && (
        <p className="text-xs text-muted-foreground">
          预览需要：在分析记录选择有样本的已停止记录，并保存当前草稿。
        </p>
      )}
      {state.selectedSessionId && (
        <p className="text-xs break-all">当前样本记录：{state.selectedSessionId}</p>
      )}
      {state.dictionaryPreview && (
        <section className="border rounded p-3 text-sm space-y-2">
          <p>
            已知 {state.dictionaryPreview.counts.known} · 未知{' '}
            {state.dictionaryPreview.counts.unknown} · 冲突{' '}
            {state.dictionaryPreview.counts.conflict} · 转换失败{' '}
            {state.dictionaryPreview.counts.conversionFailed}
          </p>
          {state.dictionaryPreview.warnings.map(w => (
            <p key={w} className="text-amber-700">
              {w}
            </p>
          ))}
          {state.dictionaryPreview.samples.map(sample => (
            <div
              key={`${sample.observationId}-${sample.sequence}`}
              className="border-t pt-2 break-all"
            >
              <p>
                {sample.nickname?.slice(0, 128) ?? '未知昵称'} · ID {sample.userId ?? '未知'}
              </p>
              {Object.entries(sample.values).map(([key, value]) => (
                <p key={key}>
                  {key}：{displayAttribute(value)}
                </p>
              ))}
            </div>
          ))}
        </section>
      )}
      {state.error?.error.code.includes('REVISION') && (
        <p className="text-sm text-amber-700">
          服务版本已重新读取，保留了本地草稿；请比较修订后重新保存、预览，不会自动覆盖其他人的配置。
        </p>
      )}
    </section>
  )
}
