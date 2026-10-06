import { useEffect, useState } from 'react'
import { versionApi } from '../services/api'

// The installed version comes from the server (git tag / Docker build arg), so
// nothing in the frontend has to be bumped per release. One request per page
// load, shared by every caller.
let versionPromise = null

export default function useAppVersion() {
  const [version, setVersion] = useState(null)
  useEffect(() => {
    let cancelled = false
    if (!versionPromise) {
      versionPromise = versionApi.getVersion()
        .then(({ data }) => data?.version || null)
        .catch(() => { versionPromise = null; return null })
    }
    versionPromise.then(v => { if (!cancelled) setVersion(v) })
    return () => { cancelled = true }
  }, [])
  return version
}
