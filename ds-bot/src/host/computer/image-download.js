// Some networks can reach the official release asset API but not github.com.
// Both routes resolve the same fixed release; archive hashes remain authoritative.
export function imageDownload(fetcher) {
  const releases = new Map()
  let preferApi = false
  return async (url, options) => {
    if (!preferApi) {
      try {
        const response = await fetcher(url, options)
        if (response.ok) return response
        await response.body?.cancel().catch(() => {})
      } catch (error) {
        if (options.signal?.aborted) throw error
      }
    }
    options.signal?.throwIfAborted()
    const match = String(url).match(/^https:\/\/github\.com\/([a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)\/releases\/download\/(cua-desktop-[a-f0-9]{40})\/(desktop-manifest\.json|desktop-image\.part-[0-9]{3})$/)
    if (!match) throw new Error('Invalid desktop download source.')
    const [, repo, tag, name] = match
    const api = `https://api.github.com/repos/${repo}`
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'DS-Bot-desktop-updates' }
    const key = `${repo}/${tag}`
    if (!releases.has(key)) {
      const response = await fetcher(`${api}/releases/tags/${tag}`, { ...options, headers, redirect: 'error' })
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {})
        throw new Error('The desktop release download is unavailable. Check the connection and retry.')
      }
      const chunks = []
      let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > 1024 * 1024) throw new Error('Desktop release metadata is too large.')
        chunks.push(Buffer.from(chunk))
      }
      const release = JSON.parse(Buffer.concat(chunks))
      if (release.tag_name !== tag || release.draft || !Array.isArray(release.assets) || release.assets.length > 100) {
        throw new Error('Invalid desktop release metadata.')
      }
      releases.set(key, release.assets)
    }
    const assets = releases.get(key).filter(asset => asset.name === name)
    if (assets.length !== 1 || !Number.isSafeInteger(assets[0].id) || assets[0].id < 1) throw new Error('The desktop release asset is missing.')
    preferApi = true
    return fetcher(`${api}/releases/assets/${assets[0].id}`, {
      ...options, headers: { ...headers, ...options.headers, Accept: 'application/octet-stream' },
    })
  }
}
