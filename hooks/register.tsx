import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ImgEditing, ImgEntry, ImgKeyStatus, ImgProvider, ImgSettings } from '../types'

const PLUGIN = 'image-mod'
const PANE = 'images'
const TOOL = `mcp__${PLUGIN}__generate_image`
const PAGE_SIZE = 6
const GALLERY_CAP = 60
const THUMB_PX = 240

const OPENAI_MODELS = ['gpt-image-1', 'dall-e-3']
const REPLICATE_MODELS = [
  'black-forest-labs/flux-schnell',
  'black-forest-labs/flux-dev',
  'black-forest-labs/flux-1.1-pro',
  'black-forest-labs/flux-1.1-pro-ultra',
  'black-forest-labs/flux-kontext-pro',
  'ideogram-ai/ideogram-v3-turbo',
  'recraft-ai/recraft-v3',
  'google/imagen-4',
  'bytedance/seedream-3',
  'stability-ai/stable-diffusion-3.5-large',
]
const CUSTOM = '__custom__'

const DEFAULT_SETTINGS: ImgSettings = {
  provider: 'openai',
  openaiModel: 'gpt-image-1',
  replicateModel: 'black-forest-labs/flux-schnell',
  outputDir: '',
}
const NO_KEYS: ImgKeyStatus = {
  openai: { has: false, source: 'none', hint: '' },
  replicate: { has: false, source: 'none', hint: '' },
}

const settings = atom({ plugin: PLUGIN, key: 'settings' } as const, DEFAULT_SETTINGS)
const keyStatus = atom({ plugin: PLUGIN, key: 'keys' } as const, NO_KEYS)
const gallery = atom({ plugin: PLUGIN, key: 'gallery' } as const, [])
const editing = atom({ plugin: PLUGIN, key: 'editing' } as const, {
  openaiKey: false,
  replicateKey: false,
  customModel: false,
})
const busy = atom({ plugin: PLUGIN, key: 'busy' } as const, '')
const page = atom({ plugin: PLUGIN, key: 'page' } as const, 0)

type Keys = Partial<Record<ImgProvider, string>>
type Dollar = EngineInterface

type GenerateInput = {
  prompt: string
  provider?: ImgProvider
  model?: string
  size?: string
  aspect_ratio?: string
  count?: number
  quality?: string
  reference_images?: string[]
  output_dir?: string
  filename?: string
  extra?: Record<string, unknown>
}

type Generated = {
  provider: ImgProvider
  model: string
  files: string[]
  note: string
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'What to draw. Be concrete about subject, style, lighting and composition.' },
    provider: {
      type: 'string',
      enum: ['openai', 'replicate'],
      description: 'Which API to use. Omit to use the default picked in the Images pane; a provider with no key is refused and the result names the one that works.',
    },
    model: {
      type: 'string',
      description:
        'Model override. OpenAI: gpt-image-1 or dall-e-3. Replicate: any owner/name (optionally owner/name:version), e.g. black-forest-labs/flux-1.1-pro, ideogram-ai/ideogram-v3-turbo, recraft-ai/recraft-v3, google/imagen-4.',
    },
    size: {
      type: 'string',
      description: 'OpenAI only. gpt-image-1: 1024x1024, 1536x1024, 1024x1536 or auto. dall-e-3: 1024x1024, 1792x1024, 1024x1792.',
    },
    aspect_ratio: {
      type: 'string',
      description: 'Replicate only. 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9. Models that take width/height get it converted.',
    },
    count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many images. Default 1.' },
    quality: { type: 'string', description: 'OpenAI only. gpt-image-1: low, medium, high, auto. dall-e-3: standard or hd.' },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Absolute paths of images to edit or use as reference. OpenAI uses the edits endpoint; Replicate uploads them and passes the first as the model\'s image input.',
    },
    output_dir: { type: 'string', description: 'Folder to save into. Default: the pane\'s "Save to" folder, else ~/Pictures/claude-images.' },
    filename: { type: 'string', description: 'Base filename without extension. Default: timestamp plus a slug of the prompt.' },
    extra: {
      type: 'object',
      description: 'Passed straight through as additional request fields (Replicate: merged into input; OpenAI: merged into the JSON body). Use image_key here to name the Replicate input field for reference images (default image, or input_image for kontext models).',
    },
  },
  required: ['prompt'],
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image'

const stamp = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const hintOf = (key: string) => `…${key.slice(-4)}`

const ratioToSize = (ratio: string, base = 1024): string => {
  const [w, h] = ratio.split(':').map(Number)
  if (!w || !h) return `${base}x${base}`
  const scale = base / Math.max(w, h)
  const round = (n: number) => Math.round((n * scale) / 64) * 64
  return `${round(w)}x${round(h)}`
}

export const register: Register = on => {
  // The keys live only here and in $.store, never in $.state or any result.
  const keys: Keys = {}
  const keySource: Partial<Record<ImgProvider, 'env' | 'pane'>> = {}

  const publishKeyStatus = ($: Dollar) =>
    update($, keyStatus, () => ({
      openai: { has: !!keys.openai, source: keySource.openai ?? 'none', hint: keys.openai ? hintOf(keys.openai) : '' },
      replicate: {
        has: !!keys.replicate,
        source: keySource.replicate ?? 'none',
        hint: keys.replicate ? hintOf(keys.replicate) : '',
      },
    }))

  const loadKeys = async ($: Dollar) => {
    const stored = ((await $.store.get('keys')) ?? {}) as Keys
    const envOpenai = await $.env.get('OPENAI_API_KEY')
    const envReplicate = await $.env.get('REPLICATE_API_TOKEN')
    keys.openai = envOpenai || stored.openai || undefined
    keys.replicate = envReplicate || stored.replicate || undefined
    keySource.openai = envOpenai ? 'env' : stored.openai ? 'pane' : undefined
    keySource.replicate = envReplicate ? 'env' : stored.replicate ? 'pane' : undefined
    await publishKeyStatus($)
  }

  const saveKey = async ($: Dollar, provider: ImgProvider, value: string) => {
    const key = value.trim()
    if (!key) return
    const stored = ((await $.store.get('keys')) ?? {}) as Keys
    await $.store.set('keys', { ...stored, [provider]: key })
    keys[provider] = key
    keySource[provider] = 'pane'
    await publishKeyStatus($)
    await update($, editing, ed => ({ ...ed, [provider === 'openai' ? 'openaiKey' : 'replicateKey']: false }))
    $.ui.toast(`${provider === 'openai' ? 'OpenAI' : 'Replicate'} key saved (${hintOf(key)})`)
  }

  const forgetKey = async ($: Dollar, provider: ImgProvider) => {
    const stored = ((await $.store.get('keys')) ?? {}) as Keys
    delete stored[provider]
    await $.store.set('keys', stored)
    await loadKeys($)
    $.ui.toast(`${provider === 'openai' ? 'OpenAI' : 'Replicate'} key forgotten`)
  }

  const loadSettings = async ($: Dollar) => {
    const stored = ((await $.store.get('settings')) ?? {}) as Partial<ImgSettings>
    await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...stored }))
  }

  const saveSettings = async ($: Dollar, patch: Partial<ImgSettings>) => {
    const next = { ...(await read($, settings)), ...patch }
    await update($, settings, () => next)
    await $.store.set('settings', next)
  }

  const loadGallery = async ($: Dollar) => {
    const stored = ((await $.store.get('gallery')) ?? []) as ImgEntry[]
    await update($, gallery, () => stored)
  }

  const addEntries = async ($: Dollar, entries: ImgEntry[]) => {
    const next = [...entries, ...(await read($, gallery))].slice(0, GALLERY_CAP)
    await update($, gallery, () => next)
    await update($, page, () => 0)
    await $.store.set('gallery', next)
  }

  const removeEntry = async ($: Dollar, id: string) => {
    const next = (await read($, gallery)).filter(entry => entry.id !== id)
    await update($, gallery, () => next)
    await $.store.set('gallery', next)
  }

  const resolveOutputDir = async ($: Dollar, requested?: string) => {
    const home = (await $.env.get('HOME')) ?? '.'
    const configured = (await read($, settings)).outputDir
    const dir = (requested || configured || `${home}/Pictures/claude-images`).replace(/^~(?=\/|$)/, home)
    await $.process.run(['mkdir', '-p', dir])
    return dir
  }

  /** curl with the key in the environment, never on the command line. */
  const curl = async ($: Dollar, key: string, args: string[], timeoutMs: number) => {
    const ran = await $.process.run(
      ['sh', '-c', 'exec curl -sS -H "Authorization: Bearer $IMAGE_MOD_KEY" "$@"', 'curl', ...args],
      { env: { IMAGE_MOD_KEY: key }, timeoutMs },
    )
    if (ran.exitCode !== 0) throw new Error(`curl failed: ${ran.stderr.trim().slice(0, 300)}`)
    return ran.stdout
  }

  const writeBase64 = async ($: Dollar, base64: string, path: string) => {
    const ran = await $.process.run(['sh', '-c', 'base64 -d > "$1"', 'sh', path], { stdin: base64, timeoutMs: 60_000 })
    if (ran.exitCode !== 0) throw new Error(`decode failed: ${ran.stderr.trim()}`)
  }

  const download = async ($: Dollar, url: string, path: string) => {
    const ran = await $.process.run(['curl', '-sSL', '-o', path, url], { timeoutMs: 120_000 })
    if (ran.exitCode !== 0) throw new Error(`download failed: ${ran.stderr.trim().slice(0, 300)}`)
  }

  const dimensions = async ($: Dollar, path: string) => {
    const ran = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
    const width = Number(/pixelWidth:\s*(\d+)/.exec(ran.stdout)?.[1] ?? 0)
    const height = Number(/pixelHeight:\s*(\d+)/.exec(ran.stdout)?.[1] ?? 0)
    return { width, height }
  }

  const thumbnail = async ($: Dollar, path: string) => {
    const thumbPath = path.replace(/\.[a-z0-9]+$/i, '') + '.thumb.jpg'
    const ran = await $.process.run([
      'sips', '-Z', String(THUMB_PX), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', path, '--out', thumbPath,
    ])
    if (ran.exitCode !== 0) throw new Error(`thumbnail failed: ${ran.stderr.trim()}`)
    const { base64 } = await $.fs.read(thumbPath, { as: 'bytes' })
    const { width, height } = await dimensions($, thumbPath)
    await $.process.run(['rm', '-f', thumbPath])
    return { thumb: base64, thumbWidth: width, thumbHeight: height }
  }

  const generateOpenAI = async ($: Dollar, key: string, model: string, req: GenerateInput, dir: string, base: string): Promise<Generated> => {
    const count = Math.min(4, Math.max(1, req.count ?? 1))
    const isDalle = model.startsWith('dall-e')
    const refs = req.reference_images ?? []
    let json: string

    if (refs.length > 0) {
      const promptFile = `${dir}/.${base}.prompt.txt`
      await $.fs.write(promptFile, req.prompt)
      const args = ['https://api.openai.com/v1/images/edits', '-F', `model=${model}`, '-F', `prompt=<${promptFile}`, '-F', `n=${count}`]
      if (req.size) args.push('-F', `size=${req.size}`)
      if (req.quality && !isDalle) args.push('-F', `quality=${req.quality}`)
      for (const ref of refs) args.push('-F', `image[]=@${ref}`)
      json = await curl($, key, args, 300_000)
      await $.process.run(['rm', '-f', promptFile])
    } else {
      const body: Record<string, unknown> = { model, prompt: req.prompt, n: isDalle ? 1 : count, ...(req.extra ?? {}) }
      if (req.size) body.size = req.size
      if (req.quality) body.quality = req.quality
      if (isDalle) body.response_format = 'b64_json'
      const res = await $.http.fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      json = res.text
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${errorMessage(json)}`)
    }

    const parsed = JSON.parse(json) as { error?: { message?: string }; data?: { b64_json?: string; url?: string; revised_prompt?: string }[] }
    if (parsed.error) throw new Error(`OpenAI: ${parsed.error.message ?? 'unknown error'}`)
    const files: string[] = []
    const notes: string[] = []
    for (const [i, item] of (parsed.data ?? []).entries()) {
      const path = `${dir}/${base}${i > 0 ? `-${i + 1}` : ''}.png`
      if (item.b64_json) await writeBase64($, item.b64_json, path)
      else if (item.url) await download($, item.url, path)
      else continue
      files.push(path)
      if (item.revised_prompt) notes.push(`revised prompt: ${item.revised_prompt}`)
    }
    if (files.length === 0) throw new Error('OpenAI returned no images')
    return { provider: 'openai', model, files, note: notes.join('\n') }
  }

  const generateReplicate = async ($: Dollar, key: string, model: string, req: GenerateInput, dir: string, base: string): Promise<Generated> => {
    const count = Math.min(4, Math.max(1, req.count ?? 1))
    const extra = { ...(req.extra ?? {}) }
    const imageKey = typeof extra.image_key === 'string' ? extra.image_key : model.includes('kontext') ? 'input_image' : 'image'
    delete extra.image_key

    const input: Record<string, unknown> = { prompt: req.prompt }
    const ratio = req.aspect_ratio ?? '1:1'
    if (model.includes('recraft')) input.size = ratioToSize(ratio)
    else input.aspect_ratio = ratio
    if (count > 1) input.num_outputs = count

    const refs = req.reference_images ?? []
    if (refs.length > 0) {
      const urls: string[] = []
      for (const ref of refs) {
        const uploaded = JSON.parse(await curl($, key, ['https://api.replicate.com/v1/files', '-F', `content=@${ref}`], 120_000)) as {
          urls?: { get?: string }
          detail?: string
        }
        if (!uploaded.urls?.get) throw new Error(`Replicate upload failed: ${uploaded.detail ?? 'no url'}`)
        urls.push(uploaded.urls.get)
      }
      input[imageKey] = urls.length === 1 ? urls[0] : urls
    }
    Object.assign(input, extra)

    const [name, version] = model.split(':')
    const endpoint = version ? 'https://api.replicate.com/v1/predictions' : `https://api.replicate.com/v1/models/${name}/predictions`
    const body = version ? { version, input } : { input }
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'wait=60' }
    const created = await $.http.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!created.ok) throw new Error(`Replicate ${created.status}: ${errorMessage(created.text)}`)

    type Prediction = { id: string; status: string; output?: unknown; error?: string | null; urls?: { get?: string } }
    let prediction = JSON.parse(created.text) as Prediction
    const deadline = (await $.clock.now()) + 5 * 60_000
    while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
      if ((await $.clock.now()) > deadline) throw new Error('Replicate: timed out after 5 minutes')
      await $.clock.sleep(2000)
      const poll = await $.http.fetch(prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${prediction.id}`, { headers })
      prediction = JSON.parse(poll.text) as Prediction
    }
    if (prediction.status !== 'succeeded') throw new Error(`Replicate ${prediction.status}: ${prediction.error ?? 'no detail'}`)

    const outputs: string[] =
      typeof prediction.output === 'string'
        ? [prediction.output]
        : Array.isArray(prediction.output)
          ? prediction.output.filter((item): item is string => typeof item === 'string')
          : []
    if (outputs.length === 0) throw new Error(`Replicate returned no image URLs (output: ${JSON.stringify(prediction.output).slice(0, 200)})`)

    const files: string[] = []
    for (const [i, url] of outputs.entries()) {
      const ext = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(url)?.[1]?.toLowerCase().replace('jpeg', 'jpg') ?? 'png'
      const path = `${dir}/${base}${i > 0 ? `-${i + 1}` : ''}.${ext}`
      await download($, url, path)
      files.push(path)
    }
    return { provider: 'replicate', model, files, note: '' }
  }

  const errorMessage = (json: string) => {
    try {
      const parsed = JSON.parse(json) as { error?: { message?: string } | string; detail?: string }
      if (typeof parsed.error === 'string') return parsed.error
      return parsed.error?.message ?? parsed.detail ?? json.slice(0, 300)
    } catch {
      return json.slice(0, 300)
    }
  }

  /** Runs one generation end to end and records it in the gallery. */
  const generate = async ($: Dollar, req: GenerateInput): Promise<{ generated: Generated; entries: ImgEntry[] }> => {
    const current = await read($, settings)
    let provider: ImgProvider = req.provider ?? current.provider
    if (!keys[provider]) {
      const other: ImgProvider = provider === 'openai' ? 'replicate' : 'openai'
      if (req.provider || !keys[other]) {
        throw new Error(
          keys[other]
            ? `No ${provider} key is set; ${other} is available. Call again with provider "${other}" or paste a key in the Images pane (/images).`
            : 'No image API key is set. Paste an OpenAI or Replicate key in the Images pane (/images), or export OPENAI_API_KEY / REPLICATE_API_TOKEN.',
        )
      }
      provider = other
    }
    const key = keys[provider] as string
    const model = req.model ?? (provider === 'openai' ? current.openaiModel : current.replicateModel)
    const dir = await resolveOutputDir($, req.output_dir)
    const base = req.filename?.trim() || `${stamp(await $.clock.now())}-${slug(req.prompt)}`

    await update($, busy, () => `Generating with ${provider} · ${model}…`)
    $.ui.status(`image: ${model}`)
    try {
      const generated =
        provider === 'openai'
          ? await generateOpenAI($, key, model, req, dir, base)
          : await generateReplicate($, key, model, req, dir, base)
      const entries: ImgEntry[] = []
      for (const path of generated.files) {
        const { width, height } = await dimensions($, path)
        const thumb = await thumbnail($, path)
        entries.push({
          id: `${base}-${entries.length}`,
          path,
          provider,
          model,
          prompt: req.prompt,
          width,
          height,
          createdAt: await $.clock.now(),
          ...thumb,
        })
      }
      await addEntries($, entries)
      void $.ui.open({ id: PANE, title: 'Images' })
      return { generated, entries }
    } finally {
      await update($, busy, () => '')
      $.ui.status(undefined)
    }
  }

  const describe = (generated: Generated) =>
    [
      `Generated ${generated.files.length} image${generated.files.length === 1 ? '' : 's'} with ${generated.provider} (${generated.model}):`,
      ...generated.files,
      generated.note,
      'Open a path with the Read tool to look at it; send it to the person with SendUserFile.',
    ]
      .filter(Boolean)
      .join('\n')

  on('session.start', async ($, e, next) => {
    await loadKeys($)
    await loadSettings($)
    await loadGallery($)
    await $.tool.register({
      name: 'generate_image',
      description:
        'Generate or edit images with OpenAI (gpt-image-1, dall-e-3) or Replicate (Flux, Ideogram, Recraft, Imagen, Seedream, SD 3.5, any owner/name). Saves PNG/JPG files to disk and returns their paths; the Images pane shows a gallery. Use reference_images to edit or guide from existing files.',
      inputSchema: INPUT_SCHEMA,
    })
    await $.command.register({ name: 'images', description: 'Open the image gallery and settings pane' })
    await $.command.register({ name: 'image', description: 'Generate an image from a prompt with the current provider and model' })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const req = e as unknown as GenerateInput
    try {
      const { generated } = await generate($, req)
      return { result: { content: [{ type: 'text', text: describe(generated) }], isError: false } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { result: { content: [{ type: 'text', text: `Image generation failed: ${message}` }], isError: true } }
    }
  })

  on('command.run', { command: 'images' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Images', focus: true })
    return { text: 'Images pane opened.' }
  })

  on('command.run', { command: 'image' }, async ($, e) => {
    const prompt = e.args.trim()
    if (!prompt) return { text: 'Usage: /image <prompt>' }
    try {
      const { generated } = await generate($, { prompt })
      return { text: describe(generated).split('\n').slice(0, -1).join('\n') }
    } catch (error) {
      return { text: `Image generation failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      // The mobile app draws no fields yet: a read-only list of what was generated.
      const { Box, Text } = $.ui.resolve(e)
      const list = await read($, gallery)
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          <Text bold>Images</Text>
          {list.length === 0 && <Text dimColor>Nothing generated yet.</Text>}
          {list.slice(0, 20).map(entry => (
            <Text key={`m-${entry.id}`}>
              {entry.model}: {entry.prompt}
            </Text>
          ))}
        </Box>
      )
    }
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const s = await read($, settings)
    const ks = await read($, keyStatus)
    const ed = await read($, editing)
    const list = await read($, gallery)
    const status = await read($, busy)
    const pageIndex = await read($, page)
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    const shown = list.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : undefined

    const providerOptions = [
      { value: 'openai', label: ks.openai.has ? 'OpenAI' : 'OpenAI (no key)' },
      { value: 'replicate', label: ks.replicate.has ? 'Replicate' : 'Replicate (no key)' },
    ]
    const isPreset = REPLICATE_MODELS.includes(s.replicateModel)
    const replicateOptions = [
      ...REPLICATE_MODELS.map(value => ({ value, label: value })),
      ...(isPreset ? [] : [{ value: s.replicateModel, label: `${s.replicateModel} (custom)` }]),
      { value: CUSTOM, label: 'Custom owner/name…' },
    ]

    const keyRow = (provider: ImgProvider) => {
      const info = ks[provider]
      const label = provider === 'openai' ? 'OpenAI' : 'Replicate'
      const isEditing = provider === 'openai' ? ed.openaiKey : ed.replicateKey
      const flag = provider === 'openai' ? 'openaiKey' : 'replicateKey'
      if (!info.has || isEditing) {
        return (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Input
              key={`${provider}-key`}
              label={`${label} API key`}
              placeholder={provider === 'openai' ? 'sk-… then Enter' : 'r8_… then Enter'}
              submitLabel="save"
              onSubmit={value => void saveKey($, provider, value)}
            />
            {isEditing && (
              <Button key={`${provider}-cancel`} dimColor onPress={() => void update($, editing, old => ({ ...old, [flag]: false }))}>
                Cancel
              </Button>
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text>
            {label} key: {info.hint} <Text dimColor>({info.source === 'env' ? 'from environment' : 'saved from pane'})</Text>
          </Text>
          <Button key={`${provider}-replace`} dimColor onPress={() => void update($, editing, old => ({ ...old, [flag]: true }))}>
            Replace
          </Button>
          {info.source === 'pane' && (
            <Button key={`${provider}-forget`} dimColor onPress={() => void forgetKey($, provider)}>
              Forget
            </Button>
          )}
        </Box>
      )
    }

    const entryRow = (entry: ImgEntry) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${entry.thumbWidth}" height="${entry.thumbHeight}" viewBox="0 0 ${entry.thumbWidth} ${entry.thumbHeight}"><image width="${entry.thumbWidth}" height="${entry.thumbHeight}" href="data:image/jpeg;base64,${entry.thumb}" xlink:href="data:image/jpeg;base64,${entry.thumb}"/></svg>`
      const when = new Date(entry.createdAt)
      const time = `${when.getHours().toString().padStart(2, '0')}:${when.getMinutes().toString().padStart(2, '0')}`
      return (
        <Box key={`entry-${entry.id}`} flexDirection="row" gap={2}>
          {Svg && <Svg source={svg} alt={entry.prompt} width={entry.thumbWidth} height={entry.thumbHeight} />}
          <Box flexDirection="column" gap={0} flexGrow={1} flexShrink={1}>
            <Text bold wrap="wrap">
              {entry.prompt}
            </Text>
            <Text dimColor>
              {entry.provider} · {entry.model} · {entry.width}×{entry.height} · {time}
            </Text>
            <Text dimColor wrap="truncate-start">
              {entry.path}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key={`open-${entry.id}`} onPress={() => void $.process.run(['open', entry.path])}>
                Open
              </Button>
              <Button key={`copy-${entry.id}`} onPress={() => void $.ui.copy({ text: entry.path, surface: e.surface })}>
                Copy path
              </Button>
              <Button key={`remove-${entry.id}`} dimColor onPress={() => void removeEntry($, entry.id)}>
                Remove
              </Button>
            </Box>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
          <Select
            key="provider"
            label="ImgProvider"
            options={providerOptions}
            value={s.provider}
            onSelect={value => void saveSettings($, { provider: value as ImgProvider })}
          />
          {s.provider === 'openai' ? (
            <Select
              key="openai-model"
              label="Model"
              options={OPENAI_MODELS.map(value => ({ value, label: value }))}
              value={s.openaiModel}
              onSelect={value => void saveSettings($, { openaiModel: value })}
            />
          ) : (
            <Select
              key="replicate-model"
              label="Model"
              options={replicateOptions}
              value={ed.customModel ? CUSTOM : s.replicateModel}
              onSelect={value =>
                void (value === CUSTOM
                  ? update($, editing, old => ({ ...old, customModel: true }))
                  : Promise.all([saveSettings($, { replicateModel: value }), update($, editing, old => ({ ...old, customModel: false }))]))
              }
            />
          )}
        </Box>
        {s.provider === 'replicate' && ed.customModel && (
          <Input
            key="custom-model"
            label="Replicate model"
            placeholder="owner/name or owner/name:version, then Enter"
            onSubmit={value => {
              const model = value.trim()
              if (!/^[\w.-]+\/[\w.-]+(:[\w]+)?$/.test(model)) {
                $.ui.toast('Model must look like owner/name')
                return
              }
              void Promise.all([saveSettings($, { replicateModel: model }), update($, editing, old => ({ ...old, customModel: false }))])
            }}
          />
        )}
        {keyRow('openai')}
        {keyRow('replicate')}
        <Input
          key="output-dir"
          label="Save to"
          placeholder="~/Pictures/claude-images"
          value={s.outputDir}
          onSubmit={value => void saveSettings($, { outputDir: value.trim() })}
        />
        {!ks.openai.has && !ks.replicate.has && (
          <Text color="yellow">No key set yet. Paste one above, or export OPENAI_API_KEY or REPLICATE_API_TOKEN and restart.</Text>
        )}
        {status && <Text color="yellow">{status}</Text>}
        <Box flexDirection="row" gap={2} alignItems="center">
          <Text bold>Gallery</Text>
          <Text dimColor>
            {list.length === 0 ? 'nothing generated yet' : `${list.length} image${list.length === 1 ? '' : 's'} · page ${pageIndex + 1}/${pages}`}
          </Text>
          {pages > 1 && (
            <Button key="newer" dimColor onPress={() => void update($, page, p => Math.max(0, p - 1))}>
              Newer
            </Button>
          )}
          {pages > 1 && (
            <Button key="older" dimColor onPress={() => void update($, page, p => Math.min(pages - 1, p + 1))}>
              Older
            </Button>
          )}
        </Box>
        {shown.map(entryRow)}
      </Box>
    )
  })
}
