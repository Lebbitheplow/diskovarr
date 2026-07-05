import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { wrappedApi } from '../services/api'
import { hoursOf, fmtInt } from '../components/wrapped/format'
import WrappedHero from '../components/wrapped/WrappedHero'
import { TopMovieSlide, TopShowSlide, OldestSlide } from '../components/wrapped/WrappedTopMedia'
import WrappedGenres from '../components/wrapped/WrappedGenres'
import WrappedTimeStats from '../components/wrapped/WrappedTimeStats'
import { BingeSlide, PercentileSlide, TasteAgeSlide, BuddySlide } from '../components/wrapped/WrappedExtras'
import { PersonalitySlide, ReviewsSlide } from '../components/wrapped/WrappedPersonality'
import WrappedActivity from '../components/wrapped/WrappedActivity'
import WrappedLeaderboard from '../components/wrapped/WrappedLeaderboard'
import WrappedPlaylistButton from '../components/wrapped/WrappedPlaylistButton'
import WrappedShareButton from '../components/wrapped/WrappedShareButton'

// Spotify-Wrapped-style story: one stat per slide, walked through in order,
// each with its own share button. Slides without data are skipped.
function buildSlides({ payload, global, currentUserId, t }) {
  const a = payload.activity
  const slides = [
    {
      key: 'hero', category: 'hero', title: t('Your year in numbers'),
      statLine: `${fmtInt(hoursOf(payload.totals.seconds))} ${t('hours watched')}`,
      node: <WrappedHero payload={payload} />,
    },
    payload.topMovies.bySeconds.length > 0 && {
      key: 'movies', category: 'movies', title: t('Your top movie'),
      statLine: `${t('Top movie')}: ${payload.topMovies.bySeconds[0].title}`,
      node: <TopMovieSlide payload={payload} />,
    },
    payload.topShows.bySeconds.length > 0 && {
      key: 'shows', category: 'shows', title: t('Your top show'),
      statLine: `${t('Top show')}: ${payload.topShows.bySeconds[0].title}`,
      node: <TopShowSlide payload={payload} />,
    },
    payload.oldest && {
      key: 'oldest', category: 'oldest', title: t('Blast from the past'),
      statLine: `${t('Oldest watch')}: ${payload.oldest.title} (${payload.oldest.year})`,
      node: <OldestSlide payload={payload} />,
    },
    payload.genres.length > 0 && {
      key: 'genres', category: 'genres', title: t('Your genres'),
      statLine: `${t('Top genre')}: ${payload.genres[0].name}`,
      node: <WrappedGenres payload={payload} />,
    },
    {
      key: 'time', category: 'time', title: t('When you watched'),
      node: <WrappedTimeStats payload={payload} />,
    },
    (payload.time.bingeDay || payload.time.streak) && {
      key: 'binge', category: 'binge', title: t('Binges & streaks'),
      statLine: payload.time.bingeDay
        ? `${hoursOf(payload.time.bingeDay.seconds)} ${t('hours in one day')}` : undefined,
      node: <BingeSlide payload={payload} />,
    },
    {
      key: 'percentile', category: 'percentile', title: t('Where you rank'),
      statLine: `${t('Top')} ${payload.percentile.viewer}% ${t('of viewers')}`,
      node: <PercentileSlide payload={payload} />,
    },
    payload.decade.eligible && {
      key: 'decade', category: 'decade', title: t('Your taste age'),
      statLine: `${t('My taste age is')} ${payload.decade.age ?? (payload.year - (payload.decade.peakYear - 18))}`,
      node: <TasteAgeSlide payload={payload} />,
    },
    payload.buddy && {
      key: 'buddy', category: 'buddy', title: t('Show buddy'),
      statLine: `${t('Show buddies with')} ${payload.buddy.userName}`,
      node: <BuddySlide payload={payload} />,
    },
    payload.personality && {
      key: 'personality', category: 'personality', title: t('Your Diskovarr personality'),
      statLine: `${t("I'm")} ${payload.personality.title}`,
      node: <PersonalitySlide payload={payload} />,
    },
    payload.reviews && {
      key: 'reviews', category: 'reviews', title: t('The critic'),
      statLine: `${fmtInt(payload.reviews.count)} ${payload.reviews.count === 1 ? t('review written') : t('reviews written')}`,
      node: <ReviewsSlide payload={payload} />,
    },
    (a.requests > 0 || a.reviews > 0 || a.reactionsReceived > 0) && {
      key: 'activity', category: 'activity', title: t('Your year on Diskovarr'),
      statLine: `${fmtInt(a.reviews)} ${t('reviews')} · ${fmtInt(a.requests)} ${t('requests')}`,
      node: <WrappedActivity payload={payload} />,
    },
    global && global.leaderboard.length > 0 && {
      key: 'leaderboard', category: 'leaderboard', title: t('Server leaderboard'),
      statLine: `${t('Top viewer')}: ${global.leaderboard[0].userName}`,
      node: <WrappedLeaderboard global={global} currentUserId={currentUserId} />,
    },
    {
      key: 'finale', category: null, title: t("That's a wrap"),
      node: (
        <div className="wrapped-center-stack">
          <div className="wrapped-hero-label">
            {fmtInt(hoursOf(payload.totals.seconds))} {t('hours')} · {fmtInt(payload.totals.distinctTitles)} {t('titles')} · {t('one great year')}
          </div>
          <p className="wrapped-caption">{t('Take your favorites with you — build the playlist in your own Plex account.')}</p>
          <WrappedPlaylistButton year={payload.year} />
          <p className="wrapped-caption">{t('See you next December!')}</p>
        </div>
      ),
    },
  ]
  return slides.filter(Boolean)
}

export default function Wrapped() {
  const { t } = useTranslation()
  const { year: yearParam } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { success: toastSuccess, error: toastError } = useToast() || {}
  const isAdmin = !!(user?.isAdmin || user?.isElevated)

  const [years, setYears] = useState(null)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [adminWorking, setAdminWorking] = useState(false)
  const [slideIdx, setSlideIdx] = useState(0)
  const touchStartX = useRef(null)

  useEffect(() => {
    wrappedApi.getYears()
      .then(({ data }) => setYears(data))
      .catch(() => setYears({ years: [], previewYear: null }))
  }, [])

  const year = yearParam
    ? Number(yearParam)
    : years ? (years.years[0] ?? years.previewYear) : null

  const load = useCallback(async (y) => {
    setLoading(true)
    setError(null)
    setData(null)
    setSlideIdx(0)
    try {
      const { data } = await wrappedApi.getWrapped(y)
      setData(data)
    } catch (e) {
      setError(e?.response?.status === 403
        ? t('This Wrapped unlocks December 1 — hang tight!')
        : t('Could not load Wrapped'))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    if (year) load(year)
  }, [year, load])

  const slides = useMemo(() => (
    data?.payload
      ? buildSlides({ payload: data.payload, global: data.global, currentUserId: user ? String(user.id) : null, t })
      : []
  ), [data, user, t])

  const clamp = useCallback((i) => Math.max(0, Math.min(slides.length - 1, i)), [slides.length])
  const goTo = useCallback((i) => setSlideIdx(clamp(i)), [clamp])

  // Keyboard navigation
  useEffect(() => {
    if (!slides.length) return
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); setSlideIdx((i) => clamp(i + 1)) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setSlideIdx((i) => clamp(i - 1)) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [slides.length, clamp])

  const onTouchStart = (e) => { touchStartX.current = e.touches[0].clientX }
  const onTouchEnd = (e) => {
    if (touchStartX.current == null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(dx) > 48) goTo(slideIdx + (dx < 0 ? 1 : -1))
  }

  const recompute = async () => {
    setAdminWorking(true)
    try {
      await wrappedApi.recompute(year)
      toastSuccess?.(t('Recomputed'))
      await load(year)
    } catch { toastError?.(t('Recompute failed')) }
    setAdminWorking(false)
  }

  const backfill = async () => {
    setAdminWorking(true)
    try {
      const { data } = await wrappedApi.backfill()
      toastSuccess?.(`${t('Backfill complete')} — ${data.rows} ${t('rows')}`)
    } catch { toastError?.(t('Backfill failed — check Tautulli connection')) }
    setAdminWorking(false)
  }

  if (!years) {
    return <div className="wrapped-page"><div className="loading-screen"><div className="spinner" /></div></div>
  }

  const allYears = [...years.years]
  if (years.previewYear && !allYears.includes(years.previewYear)) allYears.unshift(years.previewYear)

  if (!allYears.length) {
    return (
      <div className="wrapped-page">
        <div className="wrapped-empty">
          <h1>{t('Diskovarr Wrapped')}</h1>
          <p>{t('Your first Wrapped unlocks December 1. Come back then!')}</p>
        </div>
      </div>
    )
  }

  const slide = slides[slideIdx]

  return (
    <div className="wrapped-page">
      <header className="wrapped-header">
        <h1>{t('Wrapped')} <span className="wrapped-header-year">{year}</span></h1>
        <div className="wrapped-year-pills">
          {allYears.map((y) => (
            <button
              key={y}
              className={`wrapped-year-pill ${y === year ? 'active' : ''}`}
              onClick={() => navigate(`/wrapped/${y}`)}
            >
              {y}{y === years.previewYear && <span className="wrapped-preview-badge">{t('Preview')}</span>}
            </button>
          ))}
        </div>
      </header>

      {loading && <div className="loading-screen"><div className="spinner" /></div>}
      {error && <div className="wrapped-empty"><p>{error}</p></div>}

      {!loading && !error && data?.notEnoughData && (
        <div className="wrapped-empty">
          <p>{t('Not enough watch activity for a')} {year} {t('Wrapped — but the leaderboard is below.')}</p>
          <WrappedLeaderboard global={data.global} currentUserId={user ? String(user.id) : null} />
        </div>
      )}

      {!loading && !error && slide && (
        <div className="wrapped-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="wrapped-progress" role="tablist" aria-label={t('Wrapped slides')}>
            {slides.map((s, i) => (
              <button
                key={s.key}
                className={`wrapped-progress-seg ${i <= slideIdx ? 'filled' : ''}`}
                aria-label={s.title}
                onClick={() => goTo(i)}
              />
            ))}
          </div>

          <div className="wrapped-slide-head">
            <h2>{slide.title}</h2>
            {slide.category && data.shareSlug && (
              <WrappedShareButton slug={data.shareSlug} year={year} category={slide.category} statLine={slide.statLine} />
            )}
          </div>

          {/* Key on slide.key re-mounts the body so the entry animation replays */}
          <div className="wrapped-slide" key={slide.key}>
            {slide.node}
          </div>

          <div className="wrapped-stage-nav">
            <button className="wrapped-nav-btn" onClick={() => goTo(slideIdx - 1)} disabled={slideIdx === 0} aria-label={t('Back')}>
              ← {t('Back')}
            </button>
            <span className="wrapped-stage-count">{slideIdx + 1} / {slides.length}</span>
            <button className="wrapped-nav-btn primary" onClick={() => goTo(slideIdx + 1)} disabled={slideIdx === slides.length - 1} aria-label={t('Next')}>
              {t('Next')} →
            </button>
          </div>
        </div>
      )}

      {isAdmin && !loading && (
        <div className="wrapped-admin-row">
          <span>{t('Admin')}:</span>
          <button onClick={recompute} disabled={adminWorking}>{t('Recompute this year')}</button>
          <button onClick={backfill} disabled={adminWorking}>{t('Backfill full Tautulli history')}</button>
        </div>
      )}
    </div>
  )
}
