/**
 * Routine YAML helpers shared by the board server (routines CRUD) and the
 * plugin host half (claim-routine management). The routine files under
 * $DSH_HOME/routines have a small top-level schema (name/schedule/timezone/
 * prompt/cwd/profile/overlap/timeoutMin/deliver/…); prompts are block
 * scalars with arbitrary inner content, so round-tripping preserves raw text.
 */

/** Top-level scalar keys parsed by the tolerant reader. */
const SCALAR_KEYS = new Set([
  'name', 'schedule', 'timezone', 'cwd', 'profile', 'overlap', 'timeoutMin',
  'source', 'paused',
])

/**
 * Tolerant line-based parse of a routine YAML. Returns the known top-level
 * fields plus `raw` (the original text, preserved for edits) and `unknownKeys`
 * (top-level keys we did not interpret, so the editor can warn instead of
 * silently dropping them).
 */
export function parseRoutineYaml(text) {
  const out = { prompt: '', deliver: [], raw: text }
  const unknownKeys = new Set()
  const lines = String(text ?? '').split('\n')
  let i = 0
  let inPrompt = false
  while (i < lines.length) {
    const line = lines[i]
    if (inPrompt) {
      if (/^[A-Za-z0-9_-]+:/.test(line) && !line.startsWith(' ')) {
        inPrompt = false
      } else {
        if (out.prompt !== '') out.prompt += '\n'
        out.prompt += line
        i++
        continue
      }
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) {
      i++
      continue
    }
    const key = match[1]
    const value = match[2].trim()
    if (key === 'prompt') {
      if (value === '|' || value === '|-' || value === '>') {
        inPrompt = true
        i++
        continue
      }
      out.prompt = value
    } else if (key === 'deliver') {
      // deliver: is a list; collect "- type: xxx" entries until next key.
      i++
      while (i < lines.length && /^\s+-/.test(lines[i])) {
        const item = /type:\s*([A-Za-z0-9_-]+)/.exec(lines[i])
        if (item) out.deliver.push(item[1])
        i++
      }
      continue
    } else if (SCALAR_KEYS.has(key)) {
      out[key] = normalizeScalar(value)
    } else {
      unknownKeys.add(key)
    }
    i++
  }
  out.unknownKeys = [...unknownKeys]
  return out
}

function normalizeScalar(value) {
  let text = value
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1)
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  return text
}

/** Quote a scalar when it needs YAML quoting (colons, leading digits, etc.). */
function yamlScalar(value) {
  const text = String(value)
  if (text === '') return '""'
  if (/^["'\-?:\s]|[#:]\s|:\s|^[\d.]+$/.test(text) || text.includes(' #')) {
    return `"${text.replaceAll('"', '\\"')}"`
  }
  return text
}

/**
 * Serialize a routine object to YAML in the canonical layout dsh-routines
 * understands (name, schedule, timezone, prompt block, cwd, profile, overlap,
 * timeoutMin, deliver).
 */
export function serializeRoutine(routine) {
  const lines = []
  if (routine.name !== undefined) lines.push(`name: ${yamlScalar(routine.name)}`)
  if (routine.schedule !== undefined) lines.push(`schedule: ${yamlScalar(routine.schedule)}`)
  if (routine.timezone !== undefined && routine.timezone !== '') lines.push(`timezone: ${yamlScalar(routine.timezone)}`)
  if (routine.prompt !== undefined) {
    lines.push('prompt: |')
    for (const line of String(routine.prompt).split('\n')) lines.push(`  ${line}`)
  }
  if (routine.cwd !== undefined && routine.cwd !== '') lines.push(`cwd: ${yamlScalar(routine.cwd)}`)
  if (routine.profile !== undefined && routine.profile !== '') lines.push(`profile: ${yamlScalar(routine.profile)}`)
  if (routine.overlap !== undefined && routine.overlap !== '') lines.push(`overlap: ${yamlScalar(routine.overlap)}`)
  if (routine.timeoutMin !== undefined && routine.timeoutMin !== '') lines.push(`timeoutMin: ${routine.timeoutMin}`)
  if (Array.isArray(routine.deliver) && routine.deliver.length > 0) {
    lines.push('deliver:')
    for (const kind of routine.deliver) lines.push(`  - type: ${yamlScalar(kind)}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Minimal 5-field-cron next-run computation. Supports `*\/N`, plain numbers,
 * comma lists, `*`, and the `every Nh` shorthand dsh-routines accepts. Other
 * forms return null (unknown).
 */
export function computeNextRun(schedule, now = Date.now()) {
  const s = String(schedule ?? '').trim()
  const every = /^every\s+(\d+)\s*(s|m|h|d)?$/i.exec(s)
  if (every) {
    const n = Number(every[1])
    const unit = (every[2] ?? 'h').toLowerCase()
    const ms = n * (unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'd' ? 86400000 : 3600000)
    return now + ms
  }
  const parts = s.split(/\s+/)
  if (parts.length !== 5) return null
  const minuteSet = expandField(parts[0], 0, 59)
  const hourSet = expandField(parts[1], 0, 23)
  if (minuteSet === null || hourSet === null) return null
  const start = new Date(now)
  const probe = new Date(start)
  probe.setSeconds(0, 0)
  probe.setMinutes(probe.getMinutes() + 1)
  for (let day = 0; day < 8; day++) {
    for (let h = 0; h < 24; h++) {
      if (!hourSet.has(h)) continue
      for (let m = 0; m < 60; m++) {
        if (!minuteSet.has(m)) continue
        probe.setHours(h, m, 0, 0)
        if (probe.getTime() > now) return probe.getTime()
      }
    }
    probe.setDate(probe.getDate() + 1)
    probe.setHours(0, 0, 0, 0)
  }
  return null
}

function expandField(field, min, max) {
  const values = new Set()
  for (const token of String(field).split(',')) {
    const step = /^\*\/(\d+)$/.exec(token.trim())
    if (step) {
      const n = Math.max(1, Number(step[1]))
      for (let v = min; v <= max; v += n) values.add(v)
      continue
    }
    const numeric = /^(\d+)$/.exec(token.trim())
    if (numeric) {
      const v = Number(numeric[1])
      if (v < min || v > max) return null
      values.add(v)
      continue
    }
    if (token.trim() === '*') {
      for (let v = min; v <= max; v++) values.add(v)
      continue
    }
    return null
  }
  return values
}
