interface PreviewOwner {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
}

export class XiaomiPreviewOwners {
  private owners = new Map<number, { controller?: AbortController }>()

  async run<T>(owner: PreviewOwner, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    if (owner.isDestroyed()) {
      controller.abort()
      return request(controller.signal)
    }
    let entry = this.owners.get(owner.id)
    if (!entry) {
      entry = {}
      this.owners.set(owner.id, entry)
      const registered = entry
      owner.once('destroyed', () => {
        registered.controller?.abort()
        if (this.owners.get(owner.id) === registered) this.owners.delete(owner.id)
      })
    }
    entry.controller?.abort()
    entry.controller = controller
    try {
      return await request(controller.signal)
    } finally {
      if (entry.controller === controller) entry.controller = undefined
    }
  }

  cancel(ownerId: number): void {
    const entry = this.owners.get(ownerId)
    entry?.controller?.abort()
    if (entry) entry.controller = undefined
  }
}
