export type DirectorExperimentCommand = { action: 'status' | 'start' }
export type DirectorExperimentResponse = {
  ok: boolean
  ready: boolean
  url?: string
  error?: string
  modelReady?: boolean
  mode: 'local-experiment'
}
