import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { DirectorExperimentResponse } from '../../../shared/directorExperiment'
import { DirectorExperiment } from '../services/DirectorExperiment'
import { typedIpcMainHandle } from '../utils/ipc'

let experiment: DirectorExperiment | undefined

export function getDirectorExperiment() {
  return (experiment ??= new DirectorExperiment())
}

export function setupDirectorExperimentIpc() {
  typedIpcMainHandle(IPC_CHANNELS.directorExperiment.request, async (_event, command): Promise<DirectorExperimentResponse> => {
    const experiment = getDirectorExperiment()
    if (command?.action === 'start') return experiment.start()
    if (command?.action === 'status') return experiment.status()
    return { ok: false, ready: false, mode: 'local-experiment', error: '未知实验操作' }
  })
}
