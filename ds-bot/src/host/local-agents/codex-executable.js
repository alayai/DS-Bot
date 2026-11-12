const versionOf = text => {
  const match = /\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/.exec(text ?? '')
  return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4] } : undefined
}

const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i]
  if (a.pre === undefined || b.pre === undefined) return a.pre === undefined && b.pre !== undefined
  return a.pre.localeCompare(b.pre, 'en', { numeric: true }) > 0
}

// The Desktop CLI may be newer than an npm shim earlier on PATH. Probe both;
// a missing Desktop install or an unreadable version leaves the user's CLI alone.
export async function newestCodex(path, desktopPaths, probe) {
  let best = path, bestVersion
  const read = async candidate => {
    try {
      const result = await probe(candidate)
      return result?.ok ? versionOf(result.version) : undefined
    } catch { return undefined }
  }
  if (path !== undefined) {
    bestVersion = await read(path)
    if (bestVersion === undefined) return path
  }
  for (const candidate of new Set(desktopPaths)) {
    if (candidate === path) continue
    const version = await read(candidate)
    if (version !== undefined && (bestVersion === undefined || newer(version, bestVersion))) {
      best = candidate
      bestVersion = version
    }
  }
  return best
}
