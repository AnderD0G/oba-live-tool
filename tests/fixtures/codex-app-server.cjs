const readline = require('node:readline')
let initialized = false
let threadNumber = 0
const threads = new Map()
const timers = new Map()
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const notify = (method, params) => send({ method, params })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  const reply = result => send({ id: msg.id, result })
  const error = () =>
    send({ id: msg.id, error: { code: -1, message: 'private diagnostic must not leak' } })
  if (msg.method === 'initialize') {
    if (initialized) return error()
    initialized = true
    return reply({ userAgent: 'fixture' })
  }
  if (msg.method === 'initialized') return
  if (!initialized) return error()
  if (msg.method === 'config/read') return reply({ config: { mcp_servers: { fixture: {} } } })
  if (msg.method === 'thread/start') {
    if (
      !msg.params.ephemeral ||
      msg.params.config['mcp_servers.fixture.enabled'] !== false ||
      msg.params.sandbox !== 'read-only'
    )
      return error()
    const id = `thread-${++threadNumber}`
    threads.set(id, { model: msg.params.model, turns: 0 })
    return reply({ thread: { id } })
  }
  if (msg.method === 'turn/start') {
    const { threadId } = msg.params
    const thread = threads.get(threadId)
    if (++thread.turns > 1) return error()
    const turn = { id: `turn-${threadId}`, status: 'inProgress' }
    reply({ turn })
    notify('turn/started', { threadId, turn })
    const text = `你好，${thread.model || 'default'}！`
    notify('item/agentMessage/delta', { threadId: 'unrelated', itemId: 'wrong', delta: '不可泄露' })
    timers.set(
      threadId,
      setTimeout(() => {
        notify('item/agentMessage/delta', { threadId, itemId: 'answer', delta: '你好，' })
        timers.set(
          threadId,
          setTimeout(() => {
            notify('item/agentMessage/delta', {
              threadId,
              itemId: 'answer',
              delta: `${thread.model || 'default'}！`,
            })
            notify('item/completed', {
              threadId,
              item: { type: 'agentMessage', id: 'answer', text },
            })
            notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } })
          }, 60),
        )
      }, 20),
    )
    return
  }
  if (msg.method === 'turn/interrupt') {
    clearTimeout(timers.get(msg.params.threadId))
    reply({})
    notify('turn/completed', {
      threadId: msg.params.threadId,
      turn: { id: msg.params.turnId, status: 'interrupted' },
    })
    return
  }
  if (msg.method === 'thread/unsubscribe') {
    clearTimeout(timers.get(msg.params.threadId))
    threads.delete(msg.params.threadId)
    return reply({ status: 'unsubscribed' })
  }
  if (msg.method === 'test/crash') return process.exit(1)
  error()
})
process.stdin.on('end', () => process.exit(0))
