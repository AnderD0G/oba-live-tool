import type { ObsRpcClient } from '../ObsWebSocketClient'

type Data = Record<string, unknown>
interface TextSnapshot {
  name: string
  uuid: string
  kind: string
  original: string
  attempted: Set<string>
}

/** RAM-only undo for legacy hooks that materialize simulated names in OBS text settings. */
export class MockObsTextClient implements ObsRpcClient {
  private snapshots = new Map<string, TextSnapshot>()
  private tail: Promise<unknown> = Promise.resolve()
  private sealed = false
  private connection?: { url: string; password: string }
  constructor(private readonly client: ObsRpcClient) {}

  connect(url: string, password: string) {
    this.connection = { url, password }
    return this.client.connect(url, password)
  }
  disconnect() {
    return this.client.disconnect()
  }
  seal() {
    this.sealed = true
  }
  private current() {
    if (this.sealed) throw new Error('Mock OBS text writes have stopped')
  }
  private async identity(name: string) {
    const response = await this.client.call('GetInputList')
    const inputs = Array.isArray(response.inputs) ? (response.inputs as Data[]) : []
    const matches = inputs.filter(input => input.inputName === name)
    const input = matches[0]
    if (
      matches.length !== 1 ||
      typeof input?.inputUuid !== 'string' ||
      !input.inputUuid ||
      typeof input.inputKind !== 'string' ||
      !input.inputKind
    )
      throw new Error('Mock OBS text source has no unique UUID identity')
    return { name, uuid: input.inputUuid, kind: input.inputKind }
  }
  private async text(identity: { uuid: string; kind: string }) {
    const response = await this.client.call('GetInputSettings', { inputUuid: identity.uuid })
    if (response.inputKind !== identity.kind) throw new Error('Mock OBS text source kind changed')
    let text = (response.inputSettings as Data | undefined)?.text
    if (text === undefined) {
      const defaults = await this.client.call('GetInputDefaultSettings', {
        inputKind: identity.kind,
      })
      text = (defaults.defaultInputSettings as Data | undefined)?.text
    }
    if (typeof text !== 'string') throw new Error('Mock OBS source does not expose restorable text')
    return text
  }

  call(type: string, data: Data = {}): Promise<Data> {
    const settings = data.inputSettings as Data | undefined
    if (type !== 'SetInputSettings' || !settings || !Object.hasOwn(settings, 'text'))
      return this.client.call(type, data)
    const name = data.inputName
    const text = settings.text
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      typeof text !== 'string' ||
      data.overlay !== true ||
      Object.keys(settings).length !== 1
    )
      return Promise.reject(new Error('Mock OBS supports only isolated overlay text writes'))
    // Read/capture/write share one flight, including writes whose response may be ambiguous.
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        this.current()
        const identity = await this.identity(name)
        const existing = this.snapshots.get(name)
        if (existing && (existing.uuid !== identity.uuid || existing.kind !== identity.kind))
          throw new Error('Mock OBS text source was replaced')
        const before = await this.text(identity)
        const snapshot = existing ?? { ...identity, original: before, attempted: new Set<string>() }
        if (existing && before !== existing.original && !existing.attempted.has(before))
          throw new Error('Mock OBS text source was edited outside this run')
        this.current()
        this.snapshots.set(name, snapshot)
        // Capture ownership before issuing the RPC: an error can follow an applied OBS mutation.
        snapshot.attempted.add(text)
        return this.client.call('SetInputSettings', {
          inputUuid: identity.uuid,
          inputSettings: { text },
          overlay: true,
        })
      })
    this.tail = work
    return work
  }

  async restore() {
    this.seal()
    await this.tail.catch(() => {})
    const dirty = [...this.snapshots.values()].filter(snapshot => snapshot.attempted.size)
    if (!dirty.length || !this.connection) return
    await this.client.connect(this.connection.url, this.connection.password)
    const errors: unknown[] = []
    for (const snapshot of dirty) {
      try {
        const identity = await this.identity(snapshot.name)
        // A same-name replacement or rename is no longer ours to restore.
        if (identity.uuid !== snapshot.uuid || identity.kind !== snapshot.kind) continue
        const current = await this.text(identity)
        if (!snapshot.attempted.has(current) || current === snapshot.original) continue
        await this.client.call('SetInputSettings', {
          inputUuid: snapshot.uuid,
          inputSettings: { text: snapshot.original },
          overlay: true,
        })
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Mock OBS text restoration failed')
    this.snapshots.clear()
  }
}
