import React, { useState, useCallback, useEffect, useRef } from 'react'
import { profileApi, discoverApi, searchApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { posterUrl } from '../utils/media'

export default function ProfileEditForm({ profile, onCancel, onUpdated }) {
  const { error: toastError } = useToast()
  const [bio, setBio] = useState(profile.bio || '')
  const [selectedGenres, setSelectedGenres] = useState(profile.favoriteGenres || [])
  const [selectedMedia, setSelectedMedia] = useState(profile.favoriteMedia || [])
  const [allGenres, setAllGenres] = useState([])
  const [loadingGenres, setLoadingGenres] = useState(true)
  const [mediaQuery, setMediaQuery] = useState('')
  const [mediaResults, setMediaResults] = useState([])
  const [searchingMedia, setSearchingMedia] = useState(false)
  const [saving, setSaving] = useState(false)
  const [genreQuery, setGenreQuery] = useState('')
  const [genreOpen, setGenreOpen] = useState(false)
  const mediaInputRef = useRef(null)
  const mediaDropdownRef = useRef(null)
  const genreBoxRef = useRef(null)
  const suggestTimerRef = useRef(null)

  useEffect(() => {
    const loadGenres = async () => {
      try {
        const { data } = await discoverApi.getGenres()
        setAllGenres(data.genres || [])
      } catch { /* ignore */ }
      finally {
        setLoadingGenres(false)
      }
    }
    loadGenres()
  }, [])

  useEffect(() => {
    const handler = (e) => {
      if (mediaDropdownRef.current && !mediaDropdownRef.current.contains(e.target) &&
          mediaInputRef.current && !mediaInputRef.current.contains(e.target)) {
        setMediaResults([])
      }
      if (genreBoxRef.current && !genreBoxRef.current.contains(e.target)) {
        setGenreOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const fetchMediaSuggestions = useCallback(async (q) => {
    if (q.length < 2) {
      setMediaResults([])
      return
    }
    setSearchingMedia(true)
    try {
      const { data } = await searchApi.search(q, 1, null, null, {})
      setMediaResults((data.results || []).slice(0, 8))
    } catch {
      setMediaResults([])
    } finally {
      setSearchingMedia(false)
    }
  }, [])

  useEffect(() => {
    clearTimeout(suggestTimerRef.current)
    // fetchMediaSuggestions clears results for queries < 2 chars; debounce both
    // paths through it so no setState runs synchronously in the effect body.
    suggestTimerRef.current = setTimeout(() => fetchMediaSuggestions(mediaQuery), 300)
    return () => clearTimeout(suggestTimerRef.current)
  }, [mediaQuery, fetchMediaSuggestions])

  const toggleGenre = (genre) => {
    setSelectedGenres(prev => {
      if (prev.includes(genre)) return prev.filter(g => g !== genre)
      if (prev.length >= 5) return prev
      return [...prev, genre]
    })
  }

  const addMedia = (item) => {
    const mediaItem = {
      tmdbId: item.tmdbId,
      mediaType: item.mediaType || (item.type === 'tv' || item.type === 'show' ? 'tv' : 'movie'),
      title: item.title || item.name || 'Unknown',
      year: item.year || item.first_air_date?.substring(0, 4) || item.release_date?.substring(0, 4) || null,
      posterUrl: item.posterUrl || item.thumb || null,
    }
    setSelectedMedia(prev => {
      if (prev.find(m => m.tmdbId === mediaItem.tmdbId)) return prev
      if (prev.length >= 5) return prev
      return [...prev, mediaItem]
    })
    setMediaQuery('')
    setMediaResults([])
  }

  const removeMedia = (tmdbId) => {
    setSelectedMedia(prev => prev.filter(m => m.tmdbId !== tmdbId))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const { data } = await profileApi.updateProfile({
        bio: bio.trim(),
        favoriteGenres: selectedGenres,
        favoriteMedia: selectedMedia,
      })
      onUpdated(data)
    } catch (e) {
      toastError(e?.message || 'Failed to update profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="profile-edit-form">
      <div className="profile-section">
        <label className="profile-section-title" htmlFor="profile-bio">
          Bio <span style={{ color: 'var(--text-muted)', fontWeight: '400' }}>({bio.length}/500)</span>
        </label>
        <textarea
          id="profile-bio"
          value={bio}
          onChange={e => setBio(e.target.value.substring(0, 500))}
          placeholder="Tell us about yourself..."
          rows={3}
          style={{
            width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)',
            borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.9rem', resize: 'vertical',
            fontFamily: 'inherit', outline: 'none',
          }}
        />
      </div>

      <div className="profile-section">
        <label className="profile-section-title">
          Favorite Genres <span style={{ color: 'var(--text-muted)', fontWeight: '400' }}>({selectedGenres.length}/5)</span>
        </label>
        {loadingGenres ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading genres...</div>
        ) : (() => {
          const atMax = selectedGenres.length >= 5
          const matches = allGenres.filter(g =>
            !selectedGenres.includes(g) && g.toLowerCase().includes(genreQuery.trim().toLowerCase())
          ).slice(0, 10)
          return (
            <>
              <div ref={genreBoxRef} style={{ position: 'relative' }}>
                <input
                  type="text"
                  value={genreQuery}
                  onChange={e => { setGenreQuery(e.target.value); setGenreOpen(true) }}
                  onFocus={() => setGenreOpen(true)}
                  placeholder={atMax ? 'Maximum 5 genres' : 'Search genres...'}
                  disabled={atMax}
                  style={{
                    width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', fontFamily: 'inherit',
                  }}
                />
                {genreOpen && !atMax && matches.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px',
                    marginTop: '4px', maxHeight: '220px', overflowY: 'auto',
                  }}>
                    {matches.map(genre => (
                      <div
                        key={genre}
                        onMouseDown={e => { e.preventDefault(); toggleGenre(genre); setGenreQuery(''); setGenreOpen(false) }}
                        style={{ padding: '9px 12px', cursor: 'pointer', fontSize: '0.85rem', borderBottom: '1px solid var(--border)' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                      >
                        {genre}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {selectedGenres.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
                  {selectedGenres.map(genre => (
                    <span key={genre} style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px 4px 12px',
                      borderRadius: '20px', fontSize: '0.8rem', fontWeight: '500',
                      border: '1px solid var(--accent-border)', background: 'var(--accent-dim)', color: 'var(--accent)',
                    }}>
                      {genre}
                      <button onClick={() => toggleGenre(genre)} aria-label={`Remove ${genre}`} style={{
                        background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '0.9rem', padding: '0 2px', lineHeight: 1,
                      }}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )
        })()}
      </div>

      <div className="profile-section">
        <label className="profile-section-title">
          Favorite Media <span style={{ color: 'var(--text-muted)', fontWeight: '400' }}>({selectedMedia.length}/5)</span>
        </label>
        <div style={{ position: 'relative' }}>
          <input
            ref={mediaInputRef}
            type="text"
            value={mediaQuery}
            onChange={e => setMediaQuery(e.target.value)}
            placeholder="Search movies & shows..."
            disabled={selectedMedia.length >= 5}
            style={{
              width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)',
              borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          {mediaResults.length > 0 && (
            <div ref={mediaDropdownRef} style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px',
              marginTop: '4px', maxHeight: '240px', overflowY: 'auto',
            }}>
              {mediaResults.map(item => {
                const already = selectedMedia.find(m => m.tmdbId === item.tmdbId)
                return (
                  <div
                    key={item.tmdbId}
                    onMouseDown={e => { e.preventDefault(); if (!already) addMedia(item) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
                      cursor: already ? 'default' : 'pointer', opacity: already ? 0.4 : 1,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {item.posterUrl ? (
                      <img src={posterUrl(item.posterUrl)} alt="" style={{ width: '28px', height: '42px', objectFit: 'cover', borderRadius: '4px', flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: '28px', height: '42px', background: 'var(--bg-primary)', borderRadius: '4px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem' }}>?</div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title || item.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {[item.year, item.mediaType === 'tv' ? 'TV' : 'Movie'].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {already && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Added</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {searchingMedia && <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '6px' }}>Searching...</div>}
        {selectedMedia.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
            {selectedMedia.map(item => (
              <div key={item.tmdbId} style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px 4px 4px',
                background: 'var(--bg-primary)', borderRadius: '20px', border: '1px solid var(--border)',
              }}>
                {item.posterUrl ? (
                  <img src={posterUrl(item.posterUrl)} alt="" style={{ width: '24px', height: '36px', objectFit: 'cover', borderRadius: '3px' }} />
                ) : (
                  <div style={{ width: '24px', height: '36px', background: 'var(--bg-secondary)', borderRadius: '3px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem' }}>?</div>
                )}
                <span style={{ fontSize: '0.8rem', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                <button onClick={() => removeMedia(item.tmdbId)} style={{
                  background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                  fontSize: '0.9rem', padding: '0 2px', lineHeight: 1,
                }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
        <button className="btn-page" onClick={onCancel} disabled={saving} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '8px 20px', borderRadius: '8px', cursor: saving ? 'not-allowed' : 'pointer' }}>
          Cancel
        </button>
        <button
          className="btn-page"
          onClick={handleSave}
          disabled={saving}
          style={{
            background: 'var(--accent)', color: '#000', fontWeight: '600', padding: '8px 20px',
            borderRadius: '8px', border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
