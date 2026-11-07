export type ImgProvider = 'openai' | 'replicate' | 'sume'

/** Session defaults the pane edits and the tool falls back to. */
export type ImgSettings = {
  provider: ImgProvider
  openaiModel: string
  /** `owner/name`, optionally `owner/name:version`. */
  replicateModel: string
  /** A Sume image-router model id, e.g. `gpt-image-2` or `nano-banana-pro`. */
  sumeModel: string
  outputDir: string
}

/** Whether each provider has a key and where it came from. Never the key. */
export type ImgKeyInfo = { has: boolean; source: 'env' | 'pane' | 'none'; hint: string }
export type ImgKeyStatus = Record<ImgProvider, ImgKeyInfo>

/** One generated image in the gallery. */
export type ImgEntry = {
  id: string
  path: string
  provider: ImgProvider
  model: string
  prompt: string
  width: number
  height: number
  createdAt: number
  /** Thumbnail as base64 JPEG, small enough to embed in one SVG. */
  thumb: string
  thumbWidth: number
  thumbHeight: number
}

/** Which inline editors the pane is showing. */
export type ImgEditing = {
  openaiKey: boolean
  replicateKey: boolean
  sumeKey: boolean
  customModel: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'image-mod': {
      settings: ImgSettings
      keys: ImgKeyStatus
      gallery: ImgEntry[]
      editing: ImgEditing
      busy: string
      page: number
    }
  }
}
