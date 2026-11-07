import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ImgEntry, ImgKeyInfo, ImgKeyStatus, ImgProvider, ImgSettings } from '../types'

const PLUGIN = 'image-mod'
const PANE = 'images'
const TOOL = `mcp__${PLUGIN}__generate_image`
const PAGE_SIZE = 6
const GALLERY_CAP = 60
const THUMB_PX = 240

const OPENAI_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'dall-e-3']
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
const SUME_MODELS = [
  'gpt-image-2',
  'gpt-image-2.5',
  'nano-banana-pro',
  'nano-banana-2.1',
  'seedream-5-lite',
  'seedream-v4',
  'ideogram-v4.5',
  'ideogram-v3',
  'recraft-v4',
  'grok-image',
]
const SUME_API = 'https://api.sume.com'
const CUSTOM = '__custom__'

const PROVIDERS: ImgProvider[] = ['openai', 'replicate', 'sume']
const LABEL: Record<ImgProvider, string> = { openai: 'OpenAI', replicate: 'Replicate', sume: 'Sume' }
const KEY_PLACEHOLDER: Record<ImgProvider, string> = {
  openai: 'sk-… then Enter',
  replicate: 'r8_… then Enter',
  sume: 'sume_live_… then Enter',
}
const keyFlag = (provider: ImgProvider) => `${provider}Key` as 'openaiKey' | 'replicateKey' | 'sumeKey'

const DEFAULT_SETTINGS: ImgSettings = {
  provider: 'openai',
  openaiModel: 'gpt-image-2',
  replicateModel: 'black-forest-labs/flux-schnell',
  sumeModel: 'gpt-image-2',
  outputDir: '',
}
const NO_KEY: ImgKeyInfo = { has: false, source: 'none', hint: '' }
const NO_KEYS: ImgKeyStatus = { openai: NO_KEY, replicate: NO_KEY, sume: NO_KEY }

const settings = atom({ plugin: 'image-mod', key: 'settings' } as const, DEFAULT_SETTINGS)
const keyStatus = atom({ plugin: 'image-mod', key: 'keys' } as const, NO_KEYS)
const gallery = atom({ plugin: 'image-mod', key: 'gallery' } as const, [])
const editing = atom({ plugin: 'image-mod', key: 'editing' } as const, {
  openaiKey: false,
  replicateKey: false,
  sumeKey: false,
  customModel: false,
})
const busy = atom({ plugin: 'image-mod', key: 'busy' } as const, '')
const page = atom({ plugin: 'image-mod', key: 'page' } as const, 0)

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
      enum: ['openai', 'replicate', 'sume'],
      description: 'Which API to use. Omit to use the default picked in the Images pane; a provider with no key is refused and the result names the one that works.',
    },
    model: {
      type: 'string',
      description:
        'Model override. OpenAI: gpt-image-2 (default), gpt-image-1.5, gpt-image-1 or dall-e-3. Replicate: any owner/name (optionally owner/name:version), e.g. black-forest-labs/flux-1.1-pro, ideogram-ai/ideogram-v3-turbo, recraft-ai/recraft-v3, google/imagen-4. Sume: an image-router model id, e.g. gpt-image-2 (default), gpt-image-2.5, nano-banana-pro, nano-banana-2.1, seedream-5-lite, ideogram-v4.5, recraft-v4, grok-image.',
    },
    size: {
      type: 'string',
      description: 'OpenAI: gpt-image-1: 1024x1024, 1536x1024, 1024x1536 or auto; dall-e-3: 1024x1024, 1792x1024, 1024x1792. Sume: sent as image_size (a preset or WIDTHxHEIGHT) and wins over aspect_ratio.',
    },
    aspect_ratio: {
      type: 'string',
      description: 'Replicate and Sume. 1:1, 16:9, 9:16, 4:3, 3:4 (Replicate also 3:2, 2:3, 21:9). Replicate models that take width/height get it converted; Sume refuses a ratio the model does not list.',
    },
    count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many images. Default 1.' },
    quality: { type: 'string', description: 'OpenAI and Sume. gpt-image models: low, medium, high (OpenAI also auto). dall-e-3: standard or hd.' },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Absolute paths of images to edit or use as reference. OpenAI uses the edits endpoint; Replicate uploads them and passes the first as the model\'s image input; Sume uploads them and sends them as image_urls.',
    },
    output_dir: { type: 'string', description: 'Folder to save into. Default: the pane\'s "Save to" folder, else ~/Pictures/claude-images.' },
    filename: { type: 'string', description: 'Base filename without extension. Default: timestamp plus a slug of the prompt.' },
    extra: {
      type: 'object',
      description: 'Passed straight through as additional request fields (Replicate: merged into input; OpenAI and Sume: merged into the JSON body, e.g. Sume resolution or output_format). Use image_key here to name the Replicate input field for reference images (default image, or input_image for kontext models).',
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

// Module-level helpers: the engine's loader only lets $ be passed to functions
// declared at the top of the file. Keys live only here and in $.store, never in
// $.state or any tool result.
const keys: Keys = {}
const keySource: Partial<Record<ImgProvider, 'env' | 'pane'>> = {}

const keyInfo = (provider: ImgProvider): ImgKeyInfo => {
  const key = keys[provider]
  return { has: !!key, source: keySource[provider] ?? 'none', hint: key ? hintOf(key) : '' }
}

const publishKeyStatus = ($: Dollar) =>
  update($, keyStatus, () => ({ openai: keyInfo('openai'), replicate: keyInfo('replicate'), sume: keyInfo('sume') }))

const loadKeys = async ($: Dollar) => {
  const stored = ((await $.store.get('keys')) ?? {}) as Keys
  // The engine lists the variables a module reads, so each name is a literal.
  const env: Keys = {
    openai: await $.env.get('OPENAI_API_KEY'),
    replicate: await $.env.get('REPLICATE_API_TOKEN'),
    sume: await $.env.get('SUME_API_KEY'),
  }
  for (const provider of PROVIDERS) {
    const fromEnv = env[provider]
    keys[provider] = fromEnv || stored[provider] || undefined
    keySource[provider] = fromEnv ? 'env' : stored[provider] ? 'pane' : undefined
  }
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
  await update($, editing, ed => ({ ...ed, [keyFlag(provider)]: false }))
  $.ui.toast(`${LABEL[provider]} key saved (${hintOf(key)})`)
}

const forgetKey = async ($: Dollar, provider: ImgProvider) => {
  const stored = ((await $.store.get('keys')) ?? {}) as Keys
  delete stored[provider]
  await $.store.set('keys', stored)
  await loadKeys($)
  $.ui.toast(`${LABEL[provider]} key forgotten`)
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
/** curl with the key in the environment; the reply lands in outFile and is not read here. */
const curlToFile = async ($: Dollar, key: string, args: string[], timeoutMs: number, outFile: string) => {
  const ran = await $.process.run(
    ['sh', '-c', 'exec curl -sS -H "Authorization: Bearer $IMAGE_MOD_KEY" "$@"', 'curl', '-o', outFile, ...args],
    { env: { IMAGE_MOD_KEY: key }, timeoutMs },
  )
  if (ran.exitCode !== 0) throw new Error(`curl failed: ${ran.stderr.trim().slice(0, 300)}`)
}

/**
 * Decodes an OpenAI images reply on the host: the JSON can be many megabytes,
 * past what the plugin may read, so Python writes the PNGs and reports paths.
 */
const DECODE_OPENAI_REPLY = `
import base64, json, sys, urllib.request
resp, outdir, base = sys.argv[1:4]
d = json.load(open(resp))
if d.get('error'):
    print(json.dumps({'error': (d['error'] or {}).get('message', 'unknown error')})); sys.exit(0)
files, notes = [], []
for i, item in enumerate(d.get('data', [])):
    path = f"{outdir}/{base}{'' if i == 0 else '-' + str(i + 1)}.png"
    if item.get('b64_json'):
        open(path, 'wb').write(base64.b64decode(item['b64_json']))
    elif item.get('url'):
        urllib.request.urlretrieve(item['url'], path)
    else:
        continue
    files.append(path)
    if item.get('revised_prompt'):
        notes.append('revised prompt: ' + item['revised_prompt'])
print(json.dumps({'files': files, 'notes': notes}))
`
const decodeOpenAiReply = async ($: Dollar, responseFile: string, dir: string, base: string) => {
  const ran = await $.process.run(['/usr/bin/python3', '-I', '-c', DECODE_OPENAI_REPLY, responseFile, dir, base], { timeoutMs: 120_000 })
  if (ran.exitCode !== 0) throw new Error(`decode failed: ${ran.stderr.trim().slice(0, 300)}`)
  return JSON.parse(ran.stdout) as { error?: string; files?: string[]; notes?: string[] }
}

const curl = async ($: Dollar, key: string, args: string[], timeoutMs: number, outFile: string) => {
  // The reply is written to a file and read back: a multi-megabyte image
  // reply overflows the process's captured stdout and arrives cut off.
  const ran = await $.process.run(
    ['sh', '-c', 'exec curl -sS -H "Authorization: Bearer $IMAGE_MOD_KEY" "$@"', 'curl', '-o', outFile, ...args],
    { env: { IMAGE_MOD_KEY: key }, timeoutMs },
  )
  if (ran.exitCode !== 0) throw new Error(`curl failed: ${ran.stderr.trim().slice(0, 300)}`)
  try {
    return await $.fs.read(outFile)
  } finally {
    await $.process.run(['rm', '-f', outFile])
  }
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
  const responseFile = `${dir}/.${base}.response.json`

  if (refs.length > 0) {
    const promptFile = `${dir}/.${base}.prompt.txt`
    await $.fs.write(promptFile, req.prompt)
    const args = ['https://api.openai.com/v1/images/edits', '-F', `model=${model}`, '-F', `prompt=<${promptFile}`, '-F', `n=${count}`]
    if (req.size) args.push('-F', `size=${req.size}`)
    if (req.quality && !isDalle) args.push('-F', `quality=${req.quality}`)
    for (const ref of refs) args.push('-F', `image[]=@${ref}`)
    try {
      await curlToFile($, key, args, 300_000, responseFile)
    } finally {
      await $.process.run(['rm', '-f', promptFile])
    }
  } else {
    const body: Record<string, unknown> = { model, prompt: req.prompt, n: isDalle ? 1 : count, ...(req.extra ?? {}) }
    if (req.size) body.size = req.size
    if (req.quality) body.quality = req.quality
    if (isDalle) body.response_format = 'b64_json'
    // The host's $.http.fetch gives up after 30 s and a generation takes
    // longer, so the request goes through curl with the key in the environment.
    const bodyFile = `${dir}/.${base}.body.json`
    await $.fs.write(bodyFile, JSON.stringify(body))
    try {
      await curlToFile($, key, ['https://api.openai.com/v1/images/generations', '-H', 'Content-Type: application/json', '--data-binary', `@${bodyFile}`], 300_000, responseFile)
    } finally {
      await $.process.run(['rm', '-f', bodyFile])
    }
  }

  let decoded: { error?: string; files?: string[]; notes?: string[] }
  try {
    decoded = await decodeOpenAiReply($, responseFile, dir, base)
  } finally {
    await $.process.run(['rm', '-f', responseFile])
  }
  if (decoded.error) throw new Error(`OpenAI: ${decoded.error}`)
  const files = decoded.files ?? []
  if (files.length === 0) throw new Error('OpenAI returned no images')
  return { provider: 'openai', model, files, note: (decoded.notes ?? []).join('\n') }
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
      const uploaded = JSON.parse(await curl($, key, ['https://api.replicate.com/v1/files', '-F', `content=@${ref}`], 120_000, `${dir}/.${base}.upload.json`)) as {
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
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'wait=20' }
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

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

type SumeErrorBody = { error?: { code?: string; message?: string; retryable?: boolean } }
const sumeError = (res: { status: number; text: string }) => {
  try {
    const parsed = JSON.parse(res.text) as SumeErrorBody
    if (parsed.error) return `${res.status} ${parsed.error.code ?? ''}: ${parsed.error.message ?? ''}`.trim()
  } catch {}
  return `${res.status}: ${res.text.slice(0, 300)}`
}
const sumeRetryable = (res: { status: number; text: string }) => {
  try {
    const flag = (JSON.parse(res.text) as SumeErrorBody).error?.retryable
    if (typeof flag === 'boolean') return flag
  } catch {}
  return res.status === 429 || res.status >= 500
}
const retryAfterMs = (res: { headers: Record<string, string> }, fallback = 5) =>
  Math.min(30, Math.max(1, Number(res.headers['retry-after'] ?? fallback) || fallback)) * 1000

/** Uploads a local file through a presigned PUT and returns its public URL for image_urls. */
const sumeUpload = async ($: Dollar, key: string, path: string) => {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  const contentType = MIME[ext]
  if (!contentType) throw new Error(`Sume upload: unsupported file type for ${path} (png, jpg, webp or gif)`)
  const stat = await $.process.run(['stat', '-f', '%z', path])
  const size = Number(stat.stdout.trim())
  if (stat.exitCode !== 0 || !size) throw new Error(`Sume upload: cannot read ${path}`)
  const res = await $.http.fetch(`${SUME_API}/v1/files/generate-upload-url`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, size_bytes: size, filename: path.split('/').pop() }),
  })
  if (!res.ok) throw new Error(`Sume upload ${sumeError(res)}`)
  const { data } = JSON.parse(res.text) as {
    data: { public_url: string; upload_url: string; upload_headers?: Record<string, string> }
  }
  // The presigned URL carries its own signature: the API key never goes to it.
  const args = ['curl', '-sS', '--fail-with-body', '-X', 'PUT', '--data-binary', `@${path}`]
  for (const [name, value] of Object.entries(data.upload_headers ?? { 'content-type': contentType })) args.push('-H', `${name}: ${value}`)
  args.push(data.upload_url)
  const put = await $.process.run(args, { timeoutMs: 180_000 })
  if (put.exitCode !== 0) throw new Error(`Sume upload PUT failed: ${(put.stderr || put.stdout).trim().slice(0, 300)}`)
  return data.public_url
}

const generateSume = async ($: Dollar, key: string, model: string, req: GenerateInput, dir: string, base: string): Promise<Generated> => {
  const auth = { Authorization: `Bearer ${key}` }
  const count = Math.min(4, Math.max(1, req.count ?? 1))
  const imageUrls: string[] = []
  for (const ref of req.reference_images ?? []) imageUrls.push(await sumeUpload($, key, ref))

  // Sume refuses fields a model does not take, so only what was asked for goes in.
  const body: Record<string, unknown> = { model, prompt: req.prompt }
  if (count > 1) body.num_images = count
  if (req.aspect_ratio) body.aspect_ratio = req.aspect_ratio
  if (req.size) body.image_size = req.size
  if (req.quality) body.quality = req.quality
  if (imageUrls.length > 0) body.image_urls = imageUrls
  Object.assign(body, req.extra ?? {})

  const uuid = (await $.process.run(['uuidgen'])).stdout.trim()
  const headers = { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': uuid || `${base}-${await $.clock.now()}` }

  type SumeJob = {
    request_id?: string
    job?: { id?: string; status?: string }
    job_id?: string
    sume_status?: string
    status_url?: string
    result_url?: string
    terminal?: boolean
    next_poll_after_seconds?: number
  }
  let submitted: SumeJob | undefined
  for (let attempt = 0; !submitted; attempt++) {
    // Same Idempotency-Key on a retry: Sume hands back the original job, never a second charge.
    const res = await $.http.fetch(`${SUME_API}/v1/image-router/generate`, { method: 'POST', headers, body: JSON.stringify(body) })
    if (res.ok) submitted = (JSON.parse(res.text) as { data: SumeJob }).data
    else if (attempt < 3 && sumeRetryable(res)) await $.clock.sleep(retryAfterMs(res))
    else throw new Error(`Sume ${sumeError(res)}`)
  }

  const jobId = submitted.job?.id ?? submitted.request_id ?? ''
  const statusUrl = submitted.status_url ?? `${SUME_API}/v1/jobs/${jobId}/status`
  const resultUrl = submitted.result_url ?? `${SUME_API}/v1/jobs/${jobId}/result`
  let state = submitted.job?.status ?? 'queued'
  let terminal = !!submitted.terminal
  let waitMs = (submitted.next_poll_after_seconds ?? 2) * 1000
  const deadline = (await $.clock.now()) + 5 * 60_000
  while (!terminal) {
    if ((await $.clock.now()) > deadline) throw new Error(`Sume: job ${jobId} still running after 5 minutes (it keeps running; check it later rather than resubmitting)`)
    await $.clock.sleep(waitMs)
    const res = await $.http.fetch(statusUrl, { headers: auth })
    if (res.status === 429 || res.status >= 500) {
      waitMs = retryAfterMs(res)
      continue
    }
    if (!res.ok) throw new Error(`Sume status ${sumeError(res)}`)
    const data = (JSON.parse(res.text) as { data: SumeJob }).data
    terminal = !!data.terminal
    state = data.sume_status ?? state
    waitMs = Math.max(1, data.next_poll_after_seconds ?? 2) * 1000
  }

  if (state !== 'completed') {
    let reason = state
    const job = await $.http.fetch(`${SUME_API}/v1/jobs/${jobId}`, { headers: auth })
    try {
      const data = (JSON.parse(job.text) as { data?: { error?: unknown; job?: { error?: unknown } } }).data
      const err = data?.error ?? data?.job?.error
      if (typeof err === 'string') reason = err
      else if (err && typeof err === 'object') reason = (err as { message?: string }).message ?? JSON.stringify(err).slice(0, 300)
    } catch {}
    throw new Error(`Sume job ${state}: ${reason}`)
  }

  const result = await $.http.fetch(resultUrl, { headers: auth })
  if (!result.ok) throw new Error(`Sume result ${sumeError(result)}`)
  type Artifact = { type?: string; url?: string; content_type?: string }
  const artifacts = ((JSON.parse(result.text) as { data?: { result?: { artifacts?: Artifact[] } } }).data?.result?.artifacts ?? []).filter(
    a => a.url && (a.type === 'image' || a.content_type?.startsWith('image/')),
  )
  if (artifacts.length === 0) throw new Error(`Sume returned no images (job ${jobId})`)

  const files: string[] = []
  for (const [i, artifact] of artifacts.entries()) {
    const fromType = artifact.content_type?.split('/')[1]?.replace('jpeg', 'jpg')
    const fromUrl = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(artifact.url ?? '')?.[1]?.toLowerCase().replace('jpeg', 'jpg')
    const path = `${dir}/${base}${i > 0 ? `-${i + 1}` : ''}.${fromType ?? fromUrl ?? 'png'}`
    await download($, artifact.url as string, path)
    files.push(path)
  }
  return { provider: 'sume', model, files, note: `Sume job ${jobId}` }
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
    const available = PROVIDERS.filter(p => keys[p])
    const fallback = available[0]
    if (req.provider || !fallback) {
      throw new Error(
        fallback
          ? `No ${provider} key is set; ${available.join(', ')} ${available.length === 1 ? 'is' : 'are'} available. Call again with provider "${fallback}" or paste a key in the Images pane (/images).`
          : 'No image API key is set. Paste an OpenAI, Replicate or Sume key in the Images pane (/images), or export OPENAI_API_KEY / REPLICATE_API_TOKEN / SUME_API_KEY.',
      )
    }
    provider = fallback
  }
  const key = keys[provider] as string
  const model =
    req.model ?? (provider === 'openai' ? current.openaiModel : provider === 'replicate' ? current.replicateModel : current.sumeModel)
  const dir = await resolveOutputDir($, req.output_dir)
  const base = req.filename?.trim() || `${stamp(await $.clock.now())}-${slug(req.prompt)}`

  await update($, busy, () => `Generating with ${provider} · ${model}…`)
  $.ui.status(`image: ${model}`)
  try {
    const generated =
      provider === 'openai'
        ? await generateOpenAI($, key, model, req, dir, base)
        : provider === 'replicate'
          ? await generateReplicate($, key, model, req, dir, base)
          : await generateSume($, key, model, req, dir, base)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Register the tool and commands first, so a failure loading keys or the
    // gallery can never leave the session without them; then say we are here.
    await $.tool.register({
      name: 'generate_image',
      description:
        'Generate or edit images with OpenAI (gpt-image-1, dall-e-3), Replicate (Flux, Ideogram, Recraft, Imagen, Seedream, SD 3.5, any owner/name) or Sume (gpt-image-2, nano-banana-pro, Seedream, Ideogram, Recraft, Grok Imagine). Saves PNG/JPG files to disk and returns their paths; the Images pane shows a gallery. Use reference_images to edit or guide from existing files.',
      inputSchema: INPUT_SCHEMA,
    })
    await $.command.register({ name: 'images', description: 'Open the image gallery and settings pane' })
    await $.command.register({ name: 'image', description: 'Generate an image from a prompt with the current provider and model' })
    let problem = ''
    try {
      await loadKeys($)
      await loadSettings($)
      await loadGallery($)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    const has = problem ? 'keys not loaded' : PROVIDERS.map(p => `${LABEL[p]} key: ${keys[p] ? 'yes' : 'no'}`).join(' · ')
    $.ui.toast(`Image mod loaded (${has}). Type /images for the pane.`)
    if (problem) $.ui.log(`image-mod: startup problem: ${problem}`)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__image-mod__generate_image' }, async ($, e) => {
    const req = e as unknown as GenerateInput
    try {
      const { generated } = await generate($, req)
      // A plugin tool's result is the text the model reads (or content blocks).
      return { result: describe(generated) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { deny: `Image generation failed: ${message}` }
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

    // A $.state value written by an older version may lack a newer provider.
    const info = (provider: ImgProvider) => ks[provider] ?? NO_KEY
    const providerOptions = PROVIDERS.map(value => ({ value, label: info(value).has ? LABEL[value] : `${LABEL[value]} (no key)` }))
    const sumeModel = s.sumeModel ?? DEFAULT_SETTINGS.sumeModel
    const customFor = s.provider === 'sume' ? 'sume' : 'replicate'
    const presets = customFor === 'sume' ? SUME_MODELS : REPLICATE_MODELS
    const chosen = customFor === 'sume' ? sumeModel : s.replicateModel
    const modelOptions = [
      ...presets.map(value => ({ value, label: value })),
      ...(presets.includes(chosen) ? [] : [{ value: chosen, label: `${chosen} (custom)` }]),
      { value: CUSTOM, label: customFor === 'sume' ? 'Custom model id…' : 'Custom owner/name…' },
    ]
    const pickModel = (model: string) =>
      Promise.all([
        saveSettings($, customFor === 'sume' ? { sumeModel: model } : { replicateModel: model }),
        update($, editing, old => ({ ...old, customModel: false })),
      ])

    const keyRow = (provider: ImgProvider) => {
      const status = info(provider)
      const label = LABEL[provider]
      const flag = keyFlag(provider)
      const isEditing = !!ed[flag]
      if (!status.has || isEditing) {
        return (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Input
              key={`${provider}-key`}
              label={`${label} API key`}
              placeholder={KEY_PLACEHOLDER[provider]}
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
            {label} key: {status.hint} <Text dimColor>({status.source === 'env' ? 'from environment' : 'saved from pane'})</Text>
          </Text>
          <Button key={`${provider}-replace`} dimColor onPress={() => void update($, editing, old => ({ ...old, [flag]: true }))}>
            Replace
          </Button>
          {status.source === 'pane' && (
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
            label="Provider"
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
              key={`${customFor}-model`}
              label="Model"
              options={modelOptions}
              value={ed.customModel ? CUSTOM : chosen}
              onSelect={value =>
                void (value === CUSTOM ? update($, editing, old => ({ ...old, customModel: true })) : pickModel(value))
              }
            />
          )}
        </Box>
        {s.provider !== 'openai' && ed.customModel && (
          <Input
            key={`custom-model-${customFor}`}
            label={`${LABEL[customFor]} model`}
            placeholder={customFor === 'sume' ? 'model id, e.g. seedream-4-5-edit, then Enter' : 'owner/name or owner/name:version, then Enter'}
            onSubmit={value => {
              const model = value.trim()
              const valid = customFor === 'sume' ? /^[\w.-]+$/.test(model) : /^[\w.-]+\/[\w.-]+(:[\w]+)?$/.test(model)
              if (!valid) {
                $.ui.toast(customFor === 'sume' ? 'Model must be a Sume model id' : 'Model must look like owner/name')
                return
              }
              void pickModel(model)
            }}
          />
        )}
        {PROVIDERS.map(keyRow)}
        <Input
          key="output-dir"
          label="Save to"
          placeholder="~/Pictures/claude-images"
          value={s.outputDir}
          onSubmit={value => void saveSettings($, { outputDir: value.trim() })}
        />
        {!PROVIDERS.some(p => info(p).has) && (
          <Text color="yellow">No key set yet. Paste one above, or export OPENAI_API_KEY, REPLICATE_API_TOKEN or SUME_API_KEY and restart.</Text>
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
