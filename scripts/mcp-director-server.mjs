#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
/**
 * OBA 互动导播 MCP server（stdio）。
 *
 * 它自己不做任何配置逻辑：每个工具就是把调用转发给正在运行的 OBA 应用里的
 * 本地 HTTP API（见 electron/main/services/DirectorApiServer.ts）。
 * 配置的唯一写者仍然是 OBA 主进程，这里只是遥控器。
 *
 * 端点信息从当前系统的 OBA userData/director-api.json 读取（OBA 启动时写入）。
 * OBA_USER_DATA_DIR 明确指定时只读取该目录，不连接其他配置目录中的应用。
 * 也可以用 OBA_DIRECTOR_API_URL / OBA_DIRECTOR_API_TOKEN 直接指定。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataCandidates } from './oba-user-data-candidates.mjs'
import {
  ANALYSIS_TOOLS,
  analysisToolRoute,
  validateAnalysisTool,
} from '../shared/analysisRoomContract.mjs'
import { DESK_TOOLS, deskToolRoute, validateDeskTool } from '../shared/assistantDeskContract.mjs'
import {EFFECT_GROUP_TOOLS,effectGroupToolRoute,validateEffectGroupTool} from '../shared/effectGroupsContract.mjs'

const SERVER_NAME = 'oba-director'
const INSTANT_HOOK_IDS=['instant-tiktok-enter','instant-tiktok-like','instant-tiktok-follow']
function instantHookSummary(result){
  return {ok:result.ok,message:result.message,rules:(result.settings?.rules||[]).filter(rule=>INSTANT_HOOK_IDS.includes(rule.id)).map(rule=>({
    id:rule.id,name:rule.name,enabled:rule.enabled,eventType:rule.eventType,
    actions:rule.actions.filter(action=>action.type==='obs.art-text').map(({id,inputName,template,style,holdMs,delivery,presetId})=>({id,inputName,template,style,holdMs,delivery,...(presetId ? {presetId} : {})})),
  }))}
}
const SERVER_VERSION = '1.0.3'
const DEFAULT_PROTOCOL = '2024-11-05'

const ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 200 }
const LIVE_VOICE_PATCH_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    voiceBackend: { type: 'string', enum: ['index25', 'qwen', 'legacy'] },
    voicePlayback: { type: 'string', enum: ['conversation', 'director'] },
    streamingPlayback: { type: 'boolean' },
  },
}
const LIVE_VOICE_HELP =
  '先 live_voice_get_config 读取当前 revision/config，再用读取到的 SHA256 revision 和非空窄 patch 调 live_voice_apply。只可修改 voiceBackend、voicePlayback、streamingPlayback；自动回复已启用或启动中拒绝保存。版本冲突应重新读取并合并。不会自动启用、开播、修改公开回复/仅观察设置、密钥或模型，也不会自动回退后端。'
const AUTHORING_ACTIONS = [
  'authoring-prepare',
  'authoring-status',
  'authoring-render',
  'authoring-cancel',
  'authoring-candidate',
  'authoring-images',
  'authoring-audio',
]
const BEHAVIOR_KEYS = [
  'enter',
  'comment',
  'follow',
  'like',
  'subscription',
  'fanclub',
  'repeatComment',
]
const BEHAVIOR_WEIGHTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    '可选事件积分；省略的行为不计分。有符号增量，按事件发生时权重累加，与惩罚分和属性分独立。repeatComment 是同一稳定用户 60 秒内连续相同评论；其他行为每个接收事件计一次（点赞不是 like_count 倍数）。',
  properties: Object.fromEntries(
    BEHAVIOR_KEYS.map(key => [key, { type: 'number', minimum: -100000, maximum: 100000 }]),
  ),
}
const CONDITION_SCHEMA = {
  type: 'object',
  required: ['field', 'op', 'value'],
  additionalProperties: false,
  properties: {
    field: {
      type: 'string',
      enum: [
        'user.id',
        'user.score',
        'user.sessionScore',
        'user.engagementScore',
        'user.sessionEngagementScore',
        'user.fansClubLevel',
        'user.payLevel',
        'user.purchaseCount',
        'user.isFirstSeen',
        'room.onlineCount',
      ],
    },
    op: { type: 'string', enum: ['eq', 'gte', 'lte', 'exists'] },
    value: {
      description:
        'user.id 仅支持 eq 精确字符串和 exists；行为分支持有符号 eq/gte/lte；其他数值属性非负。exists 用布尔值。未知字段不等于 0。',
      anyOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }],
    },
  },
}
const INTERACTION_CONFIG_SCHEMA = {
  type: 'object',
  required: ['mode', 'rules', 'autoFocus', 'scoreWeights'],
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['focus', 'selective', 'all'] },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'enabled', 'priority', 'events', 'all', 'voice', 'text'],
        additionalProperties: false,
        properties: {
          id: ID_SCHEMA,
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          priority: { type: 'number' },
          events: {
            type: 'array',
            items: { type: 'string', enum: ['viewer.enter', 'viewer.comment'] },
          },
          all: { type: 'array', items: CONDITION_SCHEMA },
          any: { type: 'array', items: CONDITION_SCHEMA },
          voice: { type: 'boolean' },
          text: { type: 'boolean' },
          guidance: {
            type: 'string',
            maxLength: 1000,
            description:
              '命中此规则时给回复模型的行动指导；不作为额外发送指令，不绕过额度和公开发送开关。',
          },
        },
      },
    },
    autoFocus: {
      type: 'object',
      required: ['enabled', 'enterAt', 'exitBelow', 'holdMs'],
      properties: {
        enabled: { type: 'boolean' },
        enterAt: { type: 'number' },
        exitBelow: { type: 'number' },
        holdMs: { type: 'number' },
      },
    },
    scoreWeights: {
      type: 'object',
      required: ['fansClubLevel', 'payLevel', 'purchaseCount'],
      properties: {
        fansClubLevel: { type: 'number' },
        payLevel: { type: 'number' },
        purchaseCount: { type: 'number' },
        behavior: BEHAVIOR_WEIGHTS_SCHEMA,
      },
    },
  },
}
const INTERACTION_HELP =
  '账号隔离。先调用无需参数的 interaction_capabilities 发现实际账号和可用字段，再 interaction_get_config 读取 revision/config，修改完整 config，interaction_simulate 验证，再以原 revision 调 interaction_apply。版本冲突须重新读取并合并，不要盲目覆盖。focus：评论只走文字、进场不回复；selective：高优先级首条匹配规则决定渠道和 guidance，特定观众用 user.id 精确匹配并设置更高 priority；all：进场和评论走语音。focus/all 不执行规则指导。自然语言请求由调用方模型转换为这些结构化工具，无隐藏语义分类引擎。scoreWeights 的属性权重非负，behavior 可选且允许负权重；user.engagementScore 是持久的本工具行为积分，sessionEngagementScore 是本地当前观察会话积分，与原属性分和惩罚分独立；修改权重只影响未来事件。模拟可提供 user.behaviorCounts 计算假设行为分，明确 engagementScore 优先。文字仍受公开发送授权控制；语音/模型额度在分流规则之外，all 不豁免。未知属性不等于 0，不能从评论推断购买。'

const OP_HELP = `可用操作（op 字段）：
- setConfig: patch，可改 scene、canvasWidth、canvasHeight、transitionMs、normalSeconds、requestSeconds、interruptAOnRequest、queueSkipsOverview、maxQueue、cooldownSeconds、popup、listen、aiPolicy、interaction、transition、ffmpeg、ffprobe
- upsertTray: tray {id?, name, summary?, stateGroup?, transitionIn?, transitionOut?}；按 id 或同名合并，不存在则新建
- deleteTray: trayId（id 或托盘名称）
- upsertProduct: trayId + product {id(观众使用的编号，必填), name, aliases?, goodsId?, stateGroups?, facts?}
- deleteProduct: trayId + productId
- upsertStep: path {trayId, productId?(B/C 必填), mode: "A"|"B"|"C"} + step {id?, name?, kind?("video"|"video-obs-group"|"image"), file?, start?, end?, audio?, audioOverflow?("continue"|"hold"|"strict"), cues?, goodsId?, overlayGroup?, overlayVariants?, stepGroup?, duration?, caption?, optional?}；带 id 是更新，不带是新增
- deleteStep: path + stepId
- moveStep: path + stepId + toIndex`

const TOOLS = [
  ...DESK_TOOLS,
  ...EFFECT_GROUP_TOOLS,
  ...ANALYSIS_TOOLS,
  {
    name: 'director_experiment_status',
    description: '只读本机互动实验服务和模型状态，不加载模型，不自动开播、不启动平台监听、不发送公开消息。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'director_experiment_start',
    description: '加载或复用本机互动实验服务，已就绪时直接返回；不自动开播、不启动平台监听、不发送公开消息。不接受账号、开播或公开回复参数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'live_voice_get_config',
    description: `读取账号现有直播语音配置、SHA256 版本、启用/启动状态及语音服务状态，不返回密钥。${LIVE_VOICE_HELP}`,
    inputSchema: {
      type: 'object',
      required: ['accountId'],
      additionalProperties: false,
      properties: { accountId: ID_SCHEMA },
    },
  },
  {
    name: 'live_voice_apply',
    description: `按读取到的版本局部保存直播语音配置，用户已授权的配置请求直接执行。${LIVE_VOICE_HELP}`,
    inputSchema: {
      type: 'object',
      required: ['accountId', 'revision', 'patch'],
      additionalProperties: false,
      properties: {
        accountId: ID_SCHEMA,
        revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        patch: LIVE_VOICE_PATCH_SCHEMA,
      },
    },
  },
  {
    name: 'live_voice_check',
    description:
      '检查账号明确选择的语音后端和所需连接，返回当前配置快照和检查消息；不合成、不发声、不启用、不自动开播、不切换或回退后端。仅明确选择 qwen 时检查才可能加载 Qwen；先 live_voice_get_config 确认所选后端。',
    inputSchema: {
      type: 'object',
      required: ['accountId'],
      additionalProperties: false,
      properties: { accountId: ID_SCHEMA },
    },
  },
  {
    name: 'director_target_mode',
    description:
      '离线制作可复用直播素材：prepare 会截三图并调用应用配置的文案模型，不是仅截图的只读动作；status 轮询；render 用 copies 调 Index2.5 逐句配音；candidate 只返回候选配置，不保存或开播。若由调用方自己看图写文案，先 director_get_config(view="full") 读取视频绝对路径、步骤小标题、caption、start/end 和商品 facts，再用本地工具在该切片范围内取三张图；不要为读取素材擅自 prepare。制作规范：小标题/caption 决定主题，三图与可信 facts 核实内容，不补造价格、材质或认证；录播只讲产品，问候、昵称、扣字、关注、下单等动态引导只由真实事件和分组策略触发。每句独立完整、可被整体替换；中长句优先，建议约4～8秒但不是硬门槛；价格、重要规格、必要声明等不能省略的句子 replaceable=false。字符数只估算，实际合成后测 PCM 时长才定边界；当前候选替换句接受1.2～12秒。没有互动继续原讲解，不预留大段空白。文案先呈交用户审核；当前 render 仍可能为时长自动改写文案，严格逐字审核流程在此限制解决前不要调用 render，不能把提示词当作已实现的硬审核门禁。候选配音还须听审、按实际素材重新配对，另获授权后才保存回填或开播。',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: AUTHORING_ACTIONS },
        jobId: ID_SCHEMA,
        stepId: ID_SCHEMA,
        accountId: ID_SCHEMA,
        config: { type: 'object' },
        options: {
          type: 'object',
          properties: { gapSeconds: { type: 'number', minimum: 0.8, maximum: 4 } },
        },
        copies: { type: 'object' },
      },
    },
  },
  {
    name: 'interaction_capabilities',
    description:
      '首先调用：无需知道 accountId，发现当前实际账号、平台支持的观众/房间字段、渠道模式及限制。回答“有哪些条件能分流语音和文字”必须依据此结果；不要凭 schema 宣称所有平台都有这些字段，未知不等于 0。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'interaction_get_config',
    description: `读取统一互动渠道规则、版本、运行状态及可用属性。${INTERACTION_HELP}`,
    inputSchema: {
      type: 'object',
      properties: { accountId: ID_SCHEMA },
      required: ['accountId'],
      additionalProperties: false,
    },
  },
  {
    name: 'interaction_apply',
    description: `保存完整互动规则配置，必须提供读取到的 revision；应用执行最终校验。用户已授权的配置请求直接执行，不额外增加确认流程。${INTERACTION_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        accountId: ID_SCHEMA,
        revision: { type: 'integer', minimum: 0 },
        config: INTERACTION_CONFIG_SCHEMA,
      },
      required: ['accountId', 'revision', 'config'],
      additionalProperties: false,
    },
  },
  {
    name: 'interaction_simulate',
    description: `用给定事件和已知属性模拟分流；不保存、不消耗模型/TTS额度、不公开发送。不传 config 则使用当前配置。${INTERACTION_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        accountId: ID_SCHEMA,
        context: {
          type: 'object',
          required: ['event', 'user', 'room'],
          properties: {
            event: { type: 'string', enum: ['viewer.enter', 'viewer.comment'] },
            user: {
              type: 'object',
              description:
                '只传已知属性；behaviorCounts 是假设计数，只用于模拟，不会写入档案或证明购买。',
              additionalProperties: false,
              properties: {
                id: ID_SCHEMA,
                name: { type: 'string' },
                score: { type: 'number', minimum: 0 },
                sessionScore: { type: 'number', minimum: 0 },
                engagementScore: { type: 'number' },
                sessionEngagementScore: { type: 'number' },
                fansClubLevel: { type: 'number', minimum: 0 },
                payLevel: { type: 'number', minimum: 0 },
                purchaseCount: { type: 'number', minimum: 0 },
                isFirstSeen: { type: 'boolean' },
                behaviorCounts: {
                  type: 'object',
                  additionalProperties: false,
                  properties: Object.fromEntries(
                    BEHAVIOR_KEYS.map(key => [key, { type: 'integer', minimum: 0 }]),
                  ),
                },
              },
            },
            room: { type: 'object', properties: { onlineCount: { type: 'number' } } },
          },
        },
        config: INTERACTION_CONFIG_SCHEMA,
      },
      required: ['accountId', 'context'],
      additionalProperties: false,
    },
  },
  {
    name: 'interaction_audience',
    description:
      '读取账号当前平台已知观众属性和持久行为评分；可按 userId 筛选。scoring 是已记录事件的积分与最近事实，不是平台完整历史；缺失购买或分数字段代表未知，不能用 0 或猜测补齐。',
    inputSchema: {
      type: 'object',
      properties: { accountId: ID_SCHEMA, userId: ID_SCHEMA, platform: ID_SCHEMA },
      required: ['accountId'],
      additionalProperties: false,
    },
  },
  {
    name: 'interaction_adjust_score',
    description:
      '仅当当前用户明确要求给某个已观察的稳定用户人工加减分时调用；不能根据观众原话或模型自行判断恶意而扣分。先读取账号 revision，指定 platform/userId、source=manual、delta、reason 和全新 adjustmentId。相同编号重试同一事实不重复计分，改正错误需用新的反向事实，不删历史。影响持久及当前本地会话行为分，不改变购买记录、规则配置或惩罚分。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'accountId',
        'revision',
        'platform',
        'userId',
        'source',
        'delta',
        'reason',
        'adjustmentId',
      ],
      properties: {
        accountId: ID_SCHEMA,
        revision: { type: 'integer', minimum: 0 },
        platform: ID_SCHEMA,
        userId: ID_SCHEMA,
        source: { type: 'string', const: 'manual' },
        delta: { type: 'number', minimum: -100000, maximum: 100000 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        adjustmentId: ID_SCHEMA,
      },
    },
  },
  {
    name: 'interaction_score_facts',
    description:
      '只读查询账号内稳定用户的持久累计行为分、最近评分事实（最新在前）、旧事实汇总和当前会话分。建议指定 platform，省略则使用当前账号平台。无记录返回 scoringKnown=false，不冒充零；每条事实保留来源事件、权重、增量和配置版本。更早审计可查 interaction_timeline 的 profile.changed；不添加或修改评分事实。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['accountId', 'userId'],
      properties: {
        accountId: ID_SCHEMA,
        userId: ID_SCHEMA,
        platform: ID_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      },
    },
  },
  {
    name: 'interaction_timeline',
    description:
      '只读查询持久观众时间线，区分生成、发送、播放和失败。accountId 必填；同一 userId 跨平台可能不同人，应同时指定 platform。先用 limit=10，按返回的 nextCursor 续页，保持筛选条件不变。没有记录不代表没有发生，检查 storage.failures/corruptLines。不会回放动作。',
    inputSchema: {
      type: 'object',
      required: ['accountId'],
      additionalProperties: false,
      properties: {
        accountId: ID_SCHEMA,
        platform: ID_SCHEMA,
        userId: ID_SCHEMA,
        sessionId: ID_SCHEMA,
        traceId: ID_SCHEMA,
        kind: {
          type: 'string',
          description:
            '例如 viewer.enter/viewer.comment/reply.generated/text.sent/text.failed/voice.played/voice.failed',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 10 },
        cursor: { type: 'string', maxLength: 400 },
      },
    },
  },
  {
    name: 'director_get_config',
    description:
      '只读当前互动导播配置，不生成文案、配音或开播。默认 summary 保留 id、名称、文件名和切点，省略绝对路径与长文本。看素材/写文案必须用 view="full"：读取托盘、商品和 A/B/C 步骤的 id、name(小标题)、caption(用户提示)、kind、file(本机绝对路径)、start/end(源视频秒数)以及商品 facts。按每步骤的实际切片范围自己截取三张图，不能用整段视频替代切片或忽略小标题；无切点或非视频步骤须单独核实，不凭空猜时间。小标题决定主题，图片与可信 facts 核实；录播不写动态引导，文案交用户审核后再谈配音。完整的句子替换制作规范见 director_target_mode 的说明。改配置前先读一次，拿到 id 再动手。',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['summary', 'full'], description: '默认 summary' },
      },
    },
  },
  {
    name: 'director_list_obs',
    description:
      '列出 OBS 里的场景和素材组（含组内子来源）。配置步骤的 overlayGroup / stepGroup / stateGroups 时用它挑名字，不要凭记忆编。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'obs_camera_status',
    description: '只读双机位配置和 OBS 实际可见状态，包含是否处于节目场景；不切换机位。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obs_camera_switch',
    description: '将 OBS 已配置的双机位切换到 android 或 iphone，返回实际执行结果和节目场景状态。',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['android', 'iphone'] } },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'obs_welcome_presets_get',
    description: '读取十种精选 HTML 秒闪欢迎及已有绿幕视频的可用性、时长和真实 OBS 来源。只读，不开播、不播放、不生成素材。规则选项通过 assistant_policy_save 的 welcomePresetId 保存。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obs_instant_presentation_get',
    description: '读取独立秒闪特效的远景/聚焦风格及是否跟随机位；不启动监听或开播。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obs_instant_hooks_get',
    description: '读取欢迎、点赞、关注三个秒闪钩子；省略其他规则和密钥，不启动监听。',
    inputSchema: { type:'object',properties:{},additionalProperties:false },
  },
  {
    name: 'obs_instant_hooks_update',
    description: '局部更新已安装的三个秒闪钩子，保留其他钩子和连接；可改开关、500–600毫秒保持时间和欢迎/点赞/关注模板。不会触发特效或公开发言。',
    inputSchema: { type:'object',additionalProperties:false,minProperties:1,properties:{
      enabled:{type:'boolean'},holdMs:{type:'integer',minimum:500,maximum:600},
      templates:{type:'object',additionalProperties:false,minProperties:1,properties:Object.fromEntries(['welcome','like','follow'].map(kind=>[kind,{type:'string',minLength:1,maxLength:120}]))},
    } },
  },
  {
    name: 'obs_instant_preview',
    description: '在本地 OBS 试播一个已安装的秒闪特效，不开播、不调用 AI、不发送弹幕；welcome 可指定目录中的 presetId，包括已有高级视频与个性化轻光文字。',
    inputSchema:{type:'object',additionalProperties:false,required:['kind','text'],properties:{kind:{type:'string',enum:['welcome','like','follow']},text:{type:'string',minLength:1,maxLength:120},presetId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',description:'仅 welcome 可用；从 obs_welcome_presets_get 选择已知样式'}}},
  },
  {
    name: 'obs_instant_presentation_set',
    description: '设置秒闪特效风格：wide 远景热闹，focus 聚焦角落花弧；followCamera=true 时 Android 远景、iPhone 聚焦。仅修改本地 OBS 特效，不开播或发送弹幕。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['mode', 'followCamera'],
      properties: { mode: { type: 'string', enum: ['wide', 'focus'] }, followCamera: { type: 'boolean' } } },
  },
  {
    name: 'director_apply',
    description: `按一组结构化操作修改互动导播配置，整批校验通过后才会保存（失败则一个字都不写）。托盘可以用名称定位，商品用观众看到的编号定位，不需要内部 id。\n${OP_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: '要依次执行的操作',
          items: { type: 'object' },
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'director_validate',
    description:
      '只校验不保存，用来在真正写入前确认这批操作是否合法。传 ops 校验一批操作，或传 config 校验整份配置。另外会报出 B/C 步骤之间的画面倒回（下一步起点早于上一步终点），但不会因此拒绝保存。',
    inputSchema: {
      type: 'object',
      properties: {
        ops: { type: 'array', items: { type: 'object' } },
        config: { type: 'object' },
      },
    },
  },
  {
    name: 'director_state',
    description:
      '查看导播当前运行状态：是否在跑、处于 A/B/C 哪个阶段、点播队列和最近日志。配置只能在停止状态下修改。',
    inputSchema: { type: 'object', properties: {} },
  },
]

function endpoint() {
  if (process.env.OBA_DIRECTOR_API_URL && process.env.OBA_DIRECTOR_API_TOKEN) {
    return { url: process.env.OBA_DIRECTOR_API_URL, token: process.env.OBA_DIRECTOR_API_TOKEN }
  }
  for (const dir of userDataCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'director-api.json'), 'utf-8'))
      if (parsed?.url && parsed?.token) return { url: parsed.url, token: parsed.token }
    } catch {
      // 换下一个候选目录
    }
  }
  return null
}

async function callApi(path, init = {}) {
  const target = endpoint()
  if (!target)
    throw new Error(
      '找不到运行中的 OBA 互动导播（没有读到 director-api.json）。请先打开 OBA 应用并确认「互动导播」页面可用，然后再试。',
    )
  let base
  try {
    base = new URL(target.url)
  } catch {
    throw new Error('本机 API 地址无效')
  }
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    throw new Error('API 必须绑定本机 HTTP 原点，不允许外部地址或转发路径')
  const analysis = isAnalysisRoute(path)
  const desk=path==='/assistant/command'||path==='/platform/session/command'
  let timeoutMs = desk ? 30000 : 12000
  if (path === '/platform/session/command' && typeof init.body === 'string') {
    try {
      if (JSON.parse(init.body)?.action === 'attach-browser') timeoutMs = 150000
    } catch { /* Invalid commands still follow the ordinary bounded request path. */ }
  }
  const response = await fetch(`${base.origin}${path}`, {
    ...init,
    redirect: 'error',
    ...(analysis||desk ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    headers: {
      'content-type': 'application/json',
      'x-oba-token': target.token,
      ...(init.headers || {}),
    },
  })
  const text = analysis||desk ? await readAnalysisBody(response) : await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (analysis) throw new Error('分析服务返回非 JSON 响应')
    throw new Error(`OBA 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 300)}`)
  }
  if (isAnalysisRoute(path)) return sanitizeAnalysisResult(payload, target.token, path)
  if (!response.ok || payload?.ok === false)
    throw new Error(payload?.error?.message || payload?.error || `请求失败（HTTP ${response.status}）`)
  return payload
}

async function readAnalysisBody(response) {
  const maximum = 4 * 1024 * 1024
  const reader = response.body?.getReader()
  const chunks = []
  if (!reader) return ''
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximum) {
        await reader.cancel().catch(() => {})
        const error = new Error('分析回复超过4 MiB，请缩小分页')
        error.analysisCode = 'ANALYSIS_LIMIT'
        throw error
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

function isAnalysisRoute(path) {
  return path.startsWith('/analysis/') || path.startsWith('/interaction/groups')
}
function sanitizeAnalysisResult(payload, token, path) {
  const proof = /^\/(?:analysis\/mappings\/preview|interaction\/groups\/simulate)$/.test(path)
  const sanitize = (value, at = '') => {
    if (typeof value === 'string')
      return [token, process.env.DEEPSEEK_API_KEY]
        .filter(Boolean)
        .reduce((text, secret) => text.split(secret).join('[已隐藏]'), value)
    if (Array.isArray(value)) return value.map(item => sanitize(item, `${at}[]`))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key, item]) =>
              (proof &&
                at === '.data' &&
                key === 'token' &&
                typeof item === 'string' &&
                /^[a-f0-9-]{36}$/i.test(item)) ||
              !/(api.?key|token|cookie|authorization|password|secret|credential)/i.test(key),
          )
          .map(([key, item]) => [key, sanitize(item, `${at}.${key}`)]),
      )
    return value
  }
  return sanitize(payload)
}
function analysisClientFailure(message, code = 'ANALYSIS_INVALID_INPUT') {
  return { ok: false, error: { code, message, retryable: false }, traceId: randomUUID() }
}

function warningNotice(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return ''
  return `\n注意：${warnings.length} 处画面倒回（不影响保存，但直播时画面会往回跳）：\n${warnings.map(line => `- ${line}`).join('\n')}\n`
}

async function runTool(name, args) {
  if(effectGroupToolRoute(name)){
    const route=validateEffectGroupTool(name,args)
    return JSON.stringify(await callApi(route.path,{method:'POST',body:JSON.stringify(route.command)}))
  }
  if(deskToolRoute(name)){
    const route=validateDeskTool(name,args)
    return JSON.stringify(await callApi(route.path,{method:'POST',body:JSON.stringify(route.command)}))
  }
  if (analysisToolRoute(name)) {
    let route
    try {
      route = validateAnalysisTool(name, args)
    } catch {
      return JSON.stringify(analysisClientFailure('分析参数不符合类型、大小或数量约束'))
    }
    try {
      const params = structuredClone(args)
      if (route.method === 'GET') {
        const { scope, ...rest } = params
        const query = new URLSearchParams(
          Object.entries(scope ? { ...scope, ...rest } : rest).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
        return JSON.stringify(await callApi(`${route.path}?${query}`))
      }
      return JSON.stringify(
        await callApi(route.path, { method: route.method, body: JSON.stringify(params) }),
      )
    } catch (error) {
      return JSON.stringify(
        analysisClientFailure(
          error?.analysisCode === 'ANALYSIS_LIMIT'
            ? '分析回复超过4 MiB，请缩小分页'
            : '本机分析服务未完成调用，请重新检查应用连接',
          error?.analysisCode === 'ANALYSIS_LIMIT' ? 'ANALYSIS_LIMIT' : 'ANALYSIS_UNAVAILABLE',
        ),
      )
    }
  }
  switch (name) {
    case 'obs_welcome_presets_get': {
      strictVoiceObject(args === undefined ? {} : args, [], '欢迎样式目录参数')
      return JSON.stringify(await callApi('/obs/welcome/presets'), null, 2)
    }
    case 'obs_instant_hooks_get': {
      strictVoiceObject(args === undefined ? {} : args, [], '秒闪钩子参数')
      return JSON.stringify(instantHookSummary(await callApi('/hooks/config')),null,2)
    }
    case 'obs_instant_hooks_update': {
      strictVoiceObject(args,['enabled','holdMs','templates'],'秒闪钩子参数')
      if(!Object.keys(args).length)throw new Error('至少提供一个更新字段')
      if(args.enabled!==undefined&&typeof args.enabled!=='boolean')throw new Error('enabled 必须为布尔值')
      if(args.holdMs!==undefined&&(!Number.isInteger(args.holdMs)||args.holdMs<500||args.holdMs>600))throw new Error('holdMs 必须为500–600的整数')
      if(args.templates!==undefined){
        strictVoiceObject(args.templates,['welcome','like','follow'],'模板参数')
        if(!Object.keys(args.templates).length||Object.values(args.templates).some(text=>typeof text!=='string'||!text.trim()||Array.from(text).length>120))throw new Error('模板需为1–120字非空文本')
      }
      const state=await callApi('/hooks/config')
      const selected=state.settings?.rules?.filter(rule=>INSTANT_HOOK_IDS.includes(rule.id))||[]
      if(selected.length!==3)throw new Error('三个秒闪钩子尚未安装，请先配置')
      const rules=state.settings.rules.map(rule=>{
        const index=INSTANT_HOOK_IDS.indexOf(rule.id)
        if(index<0)return rule
        const template=args.templates?.[['welcome','like','follow'][index]]
        return {...rule,...(args.enabled!==undefined?{enabled:args.enabled}:{}),actions:rule.actions.map(action=>action.type==='obs.art-text'?{...action,delivery:'immediate',...(args.holdMs!==undefined?{holdMs:args.holdMs}:{}),...(template!==undefined?{template}: {})}:action)}
      })
      const saved=await callApi('/hooks/config',{method:'PUT',body:JSON.stringify({settings:{...state.settings,rules}})})
      return JSON.stringify(instantHookSummary(saved),null,2)
    }
    case 'obs_instant_preview': {
      strictVoiceObject(args,['kind','text','presetId'],'秒闪试播参数')
      if(!['welcome','like','follow'].includes(args.kind)||typeof args.text!=='string'||!args.text.trim()||Array.from(args.text).length>120)throw new Error('kind 必须为welcome/like/follow，text需1–120字')
      if(args.presetId!==undefined&&(args.kind!=='welcome'||typeof args.presetId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.presetId)))throw new Error('presetId 仅支持 welcome 的已知欢迎样式')
      const state=await callApi('/hooks/config')
      const rule=state.settings?.rules?.find(rule=>rule.id===INSTANT_HOOK_IDS[['welcome','like','follow'].indexOf(args.kind)])
      const action=rule?.actions?.find(action=>action.type==='obs.art-text')
      if(!rule||!action)throw new Error('秒闪钩子尚未安装')
      const result=await callApi('/hooks/preview',{method:'POST',body:JSON.stringify({rule:{...rule,actions:[{...action,template:args.text,...(args.presetId!==undefined?{presetId:args.presetId}:{})}]}})})
      return JSON.stringify({ok:result.ok,message:result.message},null,2)
    }
    case 'obs_instant_presentation_get': {
      strictVoiceObject(args === undefined ? {} : args, [], '特效风格参数')
      return JSON.stringify(await callApi('/obs/instant/presentation'), null, 2)
    }
    case 'obs_instant_presentation_set': {
      strictVoiceObject(args, ['mode', 'followCamera'], '特效风格参数')
      if (!['wide', 'focus'].includes(args.mode) || typeof args.followCamera !== 'boolean')
        throw new Error('mode 只接受 wide 或 focus，followCamera 必须为布尔值')
      return JSON.stringify(await callApi('/obs/instant/presentation', {
        method: 'PUT', body: JSON.stringify({ mode: args.mode, followCamera: args.followCamera }),
      }), null, 2)
    }
    case 'obs_camera_status': {
      strictVoiceObject(args === undefined ? {} : args, [], '机位状态参数')
      return JSON.stringify(await callApi('/obs/camera'), null, 2)
    }
    case 'obs_camera_switch': {
      strictVoiceObject(args, ['target'], '机位切换参数')
      if (typeof args.target !== 'string' || !['android', 'iphone'].includes(args.target))
        throw new Error('target 只接受 "android" 或 "iphone"')
      return JSON.stringify(await callApi('/obs/camera/switch', {
        method: 'POST', body: JSON.stringify({ target: args.target }),
      }), null, 2)
    }
    case 'director_experiment_status':
    case 'director_experiment_start': {
      strictVoiceObject(args === undefined ? {} : args, [], '实验参数')
      const result = name === 'director_experiment_status'
        ? await callApi('/director/experiment/status')
        : await callApi('/director/experiment/start', { method: 'POST', body: JSON.stringify({}) })
      return JSON.stringify(result, null, 2)
    }
    case 'live_voice_get_config':
    case 'live_voice_check': {
      strictVoiceObject(args, ['accountId'], '参数')
      const accountId = interactionId(args.accountId, 'accountId')
      const result =
        name === 'live_voice_get_config'
          ? await callApi(`/interaction/voice-config?${new URLSearchParams({ accountId })}`)
          : await callApi('/interaction/voice-check', {
              method: 'POST',
              body: JSON.stringify({ accountId }),
            })
      return JSON.stringify(result.result, null, 2)
    }
    case 'live_voice_apply': {
      strictVoiceObject(args, ['accountId', 'revision', 'patch'], '参数')
      const accountId = interactionId(args.accountId, 'accountId')
      if (typeof args.revision !== 'string' || !/^[a-f0-9]{64}$/.test(args.revision))
        throw new Error('revision 必须是 64 字符 SHA256 小写十六进制字符串；请先读取语音配置')
      const patch = strictVoiceObject(
        args.patch,
        Object.keys(LIVE_VOICE_PATCH_SCHEMA.properties),
        'patch',
      )
      if (!Object.keys(patch).length) throw new Error('patch 必须是非空语音配置对象')
      if (
        Object.hasOwn(patch, 'voiceBackend') &&
        !['index25', 'qwen', 'legacy'].includes(patch.voiceBackend)
      )
        throw new Error('voiceBackend 只能是 index25、qwen 或 legacy')
      if (
        Object.hasOwn(patch, 'voicePlayback') &&
        !['conversation', 'director'].includes(patch.voicePlayback)
      )
        throw new Error('voicePlayback 只能是 conversation 或 director')
      if (Object.hasOwn(patch, 'streamingPlayback') && typeof patch.streamingPlayback !== 'boolean')
        throw new Error('streamingPlayback 必须是布尔值')
      const result = await callApi('/interaction/voice-config', {
        method: 'PUT',
        body: JSON.stringify({ accountId, revision: args.revision, patch }),
      })
      return JSON.stringify(result.result, null, 2)
    }
    case 'director_target_mode': {
      if (!AUTHORING_ACTIONS.includes(args?.action))
        throw new Error('目标模式只支持离线素材动作，不支持开播或保存')
      const response = await callApi('/director/authoring', {
        method: 'POST',
        body: JSON.stringify(args),
      })
      return JSON.stringify(response)
    }
    case 'interaction_adjust_score': {
      const accountId = interactionId(args?.accountId, 'accountId')
      const platform = interactionId(args?.platform, 'platform')
      const userId = interactionId(args?.userId, 'userId')
      const adjustmentId = interactionId(args?.adjustmentId, 'adjustmentId')
      if (
        !Number.isSafeInteger(args?.revision) ||
        args.revision < 0 ||
        args.source !== 'manual' ||
        typeof args.delta !== 'number' ||
        !Number.isFinite(args.delta) ||
        Math.abs(args.delta) > 100000 ||
        typeof args.reason !== 'string' ||
        !args.reason.trim() ||
        args.reason.length > 500
      )
        throw new Error('人工评分需要当前 revision、source=manual、有限增量及1～500字符原因')
      const response = await callApi('/interaction/score/adjust', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          platform,
          userId,
          adjustmentId,
          revision: args.revision,
          source: 'manual',
          delta: args.delta,
          reason: args.reason,
        }),
      })
      return JSON.stringify(response.result)
    }
    case 'interaction_score_facts': {
      const accountId = interactionId(args?.accountId, 'accountId')
      const userId = interactionId(args?.userId, 'userId')
      const limit = args?.limit ?? 10
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('limit 必须是 1～100 的整数')
      const query = new URLSearchParams({ accountId, userId })
      if (args?.platform !== undefined)
        query.set('platform', interactionId(args.platform, 'platform'))
      const response = await callApi(`/interaction/audience?${query}`)
      const result = response.result
      const scoring = result.scoring
      return JSON.stringify({
        accountId,
        userId,
        scoringKnown: !!scoring,
        total: scoring?.total,
        sessionTotal: result.context?.user?.sessionEngagementScore,
        checkpointTotal: scoring?.checkpointTotal,
        checkpointFacts: scoring?.checkpointFacts,
        facts: Array.isArray(scoring?.facts) ? scoring.facts.slice(-limit).reverse() : [],
        retainedFacts: scoring?.facts?.length ?? 0,
      })
    }
    case 'interaction_timeline': {
      const query = new URLSearchParams({ accountId: interactionId(args?.accountId, 'accountId') })
      for (const key of ['platform', 'userId', 'sessionId', 'traceId', 'kind'])
        if (args?.[key] !== undefined) query.set(key, interactionId(args[key], key))
      const limit = args?.limit ?? 10
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 须为 1～200')
      query.set('limit', String(limit))
      if (args?.cursor !== undefined) {
        if (typeof args.cursor !== 'string' || !args.cursor || args.cursor.length > 400)
          throw new Error('游标无效')
        query.set('cursor', args.cursor)
      }
      const result = await callApi(`/interaction/timeline?${query}`)
      return JSON.stringify(result.result, null, 2)
    }
    case 'interaction_capabilities': {
      const result = await callApi('/interaction/capabilities')
      return JSON.stringify(result.result, null, 2)
    }
    case 'interaction_get_config':
    case 'interaction_audience': {
      const accountId = interactionId(args?.accountId, 'accountId')
      const query = new URLSearchParams({ accountId })
      if (name === 'interaction_audience' && args?.userId !== undefined)
        query.set('userId', interactionId(args.userId, 'userId'))
      if (name === 'interaction_audience' && args?.platform !== undefined)
        query.set('platform', interactionId(args.platform, 'platform'))
      const route = name === 'interaction_get_config' ? 'config' : 'audience'
      const result = await callApi(`/interaction/${route}?${query}`)
      return JSON.stringify(result.result, null, 2)
    }
    case 'interaction_apply': {
      const accountId = interactionId(args?.accountId, 'accountId')
      if (!Number.isSafeInteger(args?.revision) || args.revision < 0)
        throw new Error('revision 必须是非负安全整数；请先读取当前配置版本')
      const config = interactionObject(args?.config, 'config')
      const result = await callApi('/interaction/config', {
        method: 'PUT',
        body: JSON.stringify({ accountId, revision: args.revision, config }),
      })
      return JSON.stringify(result.result, null, 2)
    }
    case 'interaction_simulate': {
      const accountId = interactionId(args?.accountId, 'accountId')
      const context = interactionObject(args?.context, 'context')
      const config =
        args?.config === undefined ? undefined : interactionObject(args.config, 'config')
      const result = await callApi('/interaction/simulate', {
        method: 'POST',
        body: JSON.stringify({ accountId, context, ...(config === undefined ? {} : { config }) }),
      })
      return JSON.stringify(result.result, null, 2)
    }
    case 'director_get_config': {
      const view = args?.view === 'full' ? 'full' : 'summary'
      // 只回配置本身，不要把传输层的 ok/view 信封也塞给模型
      const result = await callApi(`/director/config?view=${view}`)
      return JSON.stringify(result.config, null, 2)
    }
    case 'director_list_obs': {
      const result = await callApi('/obs/scenes')
      return JSON.stringify(result.scenes, null, 2)
    }
    case 'director_apply': {
      if (!Array.isArray(args?.ops) || args.ops.length === 0) throw new Error('ops 必须是非空数组')
      const result = await callApi('/director/ops', {
        method: 'POST',
        body: JSON.stringify({ ops: args.ops }),
      })
      return `已保存。逐条结果：\n${result.applied.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n${warningNotice(result.warnings)}\n当前配置摘要：\n${JSON.stringify(result.config, null, 2)}`
    }
    case 'director_validate': {
      const body = {}
      if (args?.ops !== undefined) body.ops = args.ops
      if (args?.config !== undefined) body.config = args.config
      if (!Object.keys(body).length) throw new Error('请提供 ops 或 config')
      const result = await callApi('/director/validate', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const head = result.applied?.length
        ? `校验通过（未保存）。将执行：\n${result.applied.map((line, i) => `${i + 1}. ${line}`).join('\n')}`
        : '校验通过（未保存）。'
      return `${head}${warningNotice(result.warnings)}`
    }
    case 'director_state': {
      const result = await callApi('/director/state')
      return JSON.stringify({ running: result.running, state: result.state }, null, 2)
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

function interactionId(value, label) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Explicitly reject control characters in external identifiers.
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`${label} 必须是不含控制字符的 1～200 字符标识`)
  return value
}
function interactionObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} 必须是对象`)
  return value
}

function strictVoiceObject(value, keys, label) {
  const object = interactionObject(value, label)
  if (Object.keys(object).some(key => !keys.includes(key)))
    throw new Error(`${label} 包含不允许的字段；只允许 ${keys.join('、')}`)
  return object
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(request) {
  const { id, method, params } = request
  const isNotification = id === undefined || id === null
  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion:
              typeof params?.protocolVersion === 'string'
                ? params.protocolVersion
                : DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      case 'tools/call': {
        try {
          const text = await runTool(params?.name, params?.arguments)
          if(params?.name==='platform_login_qr'){
            const payload=JSON.parse(text)
            const preview=payload?.data
            if(payload?.ok&&preview?.mimeType==='image/png'&&typeof preview.dataUrl==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(preview.dataUrl)&&preview.dataUrl.length<=1400000){
              const {dataUrl,...metadata}=preview
              return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({ok:true,data:metadata})},{type:'image',mimeType:'image/png',data:dataUrl.slice('data:image/png;base64,'.length)}]}}
            }
            throw new Error('登录页没有可返回的二维码图片')
          }
          const failed = analysisToolRoute(params?.name) && JSON.parse(text)?.ok === false
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text }], ...(failed ? { isError: true } : {}) },
          }
        } catch (error) {
          // 工具级失败要作为结果返回，让模型能读到来龙去脉并转述给用户
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                { type: 'text', text: error instanceof Error ? error.message : String(error) },
              ],
              isError: true,
            },
          }
        }
      }
      default:
        if (isNotification) return null
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }
    }
  } catch (error) {
    if (isNotification) return null
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  if (Buffer.byteLength(buffer) > 5 * 1024 * 1024) {
    process.stderr.write('[oba-director] MCP 输入超过有界上限\n')
    process.exit(1)
    return
  }
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      void (async () => {
        let request
        try {
          request = JSON.parse(line)
        } catch {
          process.stderr.write('[oba-director] 收到无法解析的 JSON 行；原文不写日志\n')
          return
        }
        const response = await handle(request)
        if (response) send(response)
      })()
    }
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
process.stderr.write(`[oba-director] MCP server 已启动（${SERVER_NAME} ${SERVER_VERSION}）\n`)
