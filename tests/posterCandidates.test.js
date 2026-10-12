import { describe, it, expect } from 'vitest'
import { posterCandidates } from '../src/utils/media'

describe('posterCandidates', () => {
  it('keeps the media-server art first and the CDN copy as the fallback', () => {
    expect(posterCandidates('/library/metadata/1/thumb/2', 'https://image.tmdb.org/t/p/w500/a.jpg'))
      .toEqual(['/library/metadata/1/thumb/2', 'https://image.tmdb.org/t/p/w500/a.jpg'])
  })

  it('drops blanks and repeats', () => {
    expect(posterCandidates(null, 'https://x/a.jpg', '', undefined, 'https://x/a.jpg')).toEqual(['https://x/a.jpg'])
    expect(posterCandidates(undefined, null)).toEqual([])
  })
})
