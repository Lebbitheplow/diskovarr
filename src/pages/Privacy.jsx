import React from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { LogoIcon } from '../components/SideRail'

// Deliberately not routed through i18n. Partially translated legal text is
// worse than none — every string here would fall back to English anyway, and a
// machine-translated privacy notice can misstate what the server actually does.
// If this is ever localised it should be as whole reviewed documents.

const UPDATED = '1 September 2026'

function Section({ id, title, children }) {
  return (
    <section className="legal-section" id={id}>
      <h2 className="legal-h2">{title}</h2>
      {children}
    </section>
  )
}

export default function Privacy() {
  const { user } = useAuth()

  return (
    <>
      {/* Readable signed-out: the app shell isn't mounted then, so the page
          carries its own brand header in that case. */}
      {!user && (
        <header className="legal-topbar">
          <Link to="/login" className="legal-brand">
            <span className="legal-brand-mark"><LogoIcon /></span>
            <span>Diskovarr</span>
          </Link>
        </header>
      )}

      <main className="main-content legal-page">
        <div className="hero">
          <h1 className="hero-title">Privacy Notice</h1>
          <p className="hero-sub">Last updated {UPDATED}</p>
        </div>

        <div className="legal-callout">
          <p>
            <strong>Diskovarr is self-hosted software.</strong> This server is run by a private
            individual or group — your <em>server administrator</em> — on hardware they control.
            It is not operated by the Diskovarr project, and there is no company behind it. Your
            administrator decides who may sign in, where the server is hosted, and which optional
            integrations are switched on.
          </p>
          <p>
            This notice describes what the software does with your information. Your administrator
            is the person responsible for it, and the person to contact about it.
          </p>
        </div>

        <Section id="collect" title="1. What information we collect">
          <h3 className="legal-h3">From your media server account</h3>
          <p>
            You sign in with an existing Plex or Jellyfin account. Diskovarr stores the account
            identifier, your username, your avatar image URL, and an access token issued by that
            server so it can read your library and watch data on your behalf. If you link a Plex
            and a Jellyfin account together, the link between them is stored too.
          </p>

          <h3 className="legal-h3">Activity you create in Diskovarr</h3>
          <ul className="legal-list">
            <li>Watch history mirrored from Plex (via Tautulli) or Jellyfin — titles, timestamps, progress, and the device resolution and bitrate reported by the server</li>
            <li>Ratings, watchlist entries, and titles you dismiss from recommendations</li>
            <li>Reviews, review comments, and reactions</li>
            <li>Accounts you follow, and your profile bio and favourite genres and titles</li>
            <li>Requests you submit, and issues you report, including any notes you write</li>
            <li>Saved monitors and their matching criteria</li>
            <li>Your preferences — language, region, mature-content visibility, review privacy, and notification settings</li>
          </ul>

          <h3 className="legal-h3">Notification settings you choose to provide</h3>
          <p>
            If you enable notifications, Diskovarr stores whatever is needed to deliver them: a
            Discord webhook URL and user ID, Pushover user and application keys, a Telegram chat
            ID, a Pushbullet access token, a browser push subscription, or a PGP key. These are
            stored only because you entered them, and only to send you the notifications you asked
            for. You can clear them at any time in Settings.
          </p>
          <p>
            <strong>Email address.</strong> If — and only if — you turn on email notifications, the
            address you type into <strong>Settings → Notifications → Email</strong> is stored so
            notifications can be sent to it. It is used for nothing else: no marketing, no
            newsletters, and it is never shared. Your address is not taken from your Plex or
            Jellyfin account; Diskovarr only ever has the one you enter yourself. Clearing the
            field and saving removes it from the database.
          </p>

          <h3 className="legal-h3">Technical information</h3>
          <ul className="legal-list">
            <li>One session cookie (<code>diskovarr.react.sid</code>), described in section 6</li>
            <li>Your IP address is recorded in the server's log when you sign in or fail to sign in, and is used in memory to rate-limit repeated sign-in attempts</li>
            <li>Ordinary web server logs of requests made to the server</li>
          </ul>

          <h3 className="legal-h3">What we do not collect</h3>
          <ul className="legal-list">
            <li><strong>No email address unless you provide one.</strong> Your email is never read from your Plex or Jellyfin account. The only way Diskovarr has an address for you is if you enter one to switch on email notifications, as described above</li>
            <li><strong>No payment information.</strong> Nothing is sold and no payments are processed</li>
            <li><strong>No location data.</strong> Your device location is never requested or recorded</li>
            <li><strong>No analytics, tracking, advertising, or fingerprinting.</strong> There is no analytics package, no advertising network, no marketing pixels, and no third-party tracker in this application</li>
            <li><strong>No data purchased from brokers or public databases</strong></li>
          </ul>
        </Section>

        <Section id="use" title="2. How we use your information">
          <p>Your information is used only to run the features you see:</p>
          <ul className="legal-list">
            <li>To sign you in and keep you signed in</li>
            <li>To build your personal recommendations from your watch history, ratings, and the genres, cast, and directors you tend to watch</li>
            <li>To show what is already in the library, and to submit and track requests for what is not</li>
            <li>To power the community features you take part in — reviews, comments, reactions, and follows</li>
            <li>To send you the notifications you have enabled</li>
            <li>To keep the service working and secure, including rate-limiting sign-in attempts</li>
          </ul>
          <p>
            Your information is <strong>not</strong> used for advertising, profiling for advertising,
            marketing emails, or any automated decision-making that has a legal or similarly
            significant effect on you.
          </p>
        </Section>

        <Section id="basis" title="3. Why we are allowed to process it">
          <p>
            Where the UK or EU GDPR applies, the processing above rests on the necessity of
            providing a service you asked to use, and on the legitimate interest of running a
            private media server for its invited members securely. The optional extras — the
            notification channels you configure, and making your reviews public — rest on your
            consent, which you can withdraw at any time in Settings without losing access to the
            rest of the service.
          </p>
        </Section>

        <Section id="sharing" title="4. Who your information is shared with">
          <p className="legal-lead">
            Your information is never sold, rented, or shared for advertising. There are no
            advertising networks, data brokers, or marketing partners involved in this service.
          </p>
          <p>
            Diskovarr talks to the following services in order to work. Which of these are active
            depends on what your administrator has configured.
          </p>
          <ul className="legal-list">
            <li><strong>Your Plex and/or Jellyfin server</strong> — to authenticate you, read your library, watch state, ratings, and watchlist, and to write back changes such as watchlist additions</li>
            <li><strong>plex.tv</strong> — for Plex sign-in and, if used, your Plex watchlist</li>
            <li><strong>Tautulli</strong> — where configured, as the source of Plex watch history</li>
            <li><strong>The Movie Database (TMDB)</strong> — for artwork, synopses, cast, and metadata. Requests to TMDB contain the title or ID being looked up, not your identity. Poster and backdrop images load in your browser directly from TMDB's image servers</li>
            <li><strong>Request applications</strong> — Sonarr, Radarr, Overseerr, DUMB, or the bundled YouTube downloader, where enabled. A request sends the title being requested and, depending on the application, the requesting username</li>
            <li><strong>Notification providers you enable</strong> — Discord, Telegram, Pushover, Pushbullet, Gotify, ntfy, Slack, a custom webhook, browser push, or email through your administrator's SMTP server. The content of your notification is sent to whichever of these you turned on</li>
            <li><strong>GitHub</strong> — the admin panel checks the public releases feed for a newer version. This sends no personal information</li>
            <li><strong>YouTube</strong> — see section 6</li>
          </ul>
          <p>
            Information may also be disclosed if your administrator is legally required to do so,
            or where it is necessary to investigate abuse of the server.
          </p>
        </Section>

        <Section id="visible" title="5. What other people on this server can see">
          <p>
            Diskovarr has community features, so some of what you do is visible to other signed-in
            members by design:
          </p>
          <ul className="legal-list">
            <li>Your username, avatar, profile bio, and favourite genres and titles</li>
            <li>Your reviews and ratings, unless you set reviews to private in <strong>Settings → Privacy</strong></li>
            <li>Your comments and reactions on reviews</li>
            <li>Who you follow, and who follows you</li>
            <li>Aggregate popularity — what is most watched on the server over the last 90 days</li>
          </ul>
          <p>
            Administrators can additionally see the request queue and reported issues across all
            users, including who submitted them, in order to act on them.
          </p>
          <p>
            <strong>Shared review links.</strong> A review can be shared by link. If your
            administrator has configured a public address for this server, that link and its preview
            card — showing the title, artwork, your rating, your username, and your review text — can
            be opened by anyone who has the link, without signing in, and may be fetched by any
            service that unfurls links, such as a chat application. Setting your reviews to private
            stops this.
          </p>
        </Section>

        <Section id="cookies" title="6. Cookies and embedded content">
          <p>
            Diskovarr sets <strong>one</strong> cookie, <code>diskovarr.react.sid</code>. It holds a
            session identifier so the server knows you are signed in. It is marked HttpOnly and
            SameSite=Lax, is marked Secure when the server is reached over HTTPS, and expires after
            30 days. It is strictly necessary — the application cannot keep you signed in without
            it — and it is not used for tracking.
          </p>
          <p>
            There are no analytics cookies, advertising cookies, pixels, or beacons.
          </p>
          <p>
            <strong>YouTube trailers.</strong> When a title's detail window includes a trailer, it is
            embedded through <code>youtube-nocookie.com</code>, YouTube's privacy-enhanced player,
            which does not set YouTube's tracking cookies unless you actually play the video.
            YouTube still receives your IP address in order to serve the video, and once you press
            play Google's privacy policy governs what happens next rather than this notice. Nothing
            is sent to YouTube unless you open a detail window for a title that has a trailer.
          </p>
        </Section>

        <Section id="location" title="7. Where your information is held">
          <p>
            Everything Diskovarr stores lives in a database file on the machine your administrator
            runs this server on, wherever that is. It is not hosted on Diskovarr project
            infrastructure, and there is no cloud backup unless your administrator has arranged one.
            The third-party services listed in section 4 process data on their own infrastructure,
            which may be in a different country from you.
          </p>
        </Section>

        <Section id="retention" title="8. How long it is kept">
          <p>
            Your account record, activity, and preferences are kept for as long as your account
            exists on this server. Notification credentials, including any email address you
            entered, are kept until you clear them or your account is removed. Accounts that are removed from the underlying Plex or Jellyfin
            server are pruned from Diskovarr along with their data. Reviews and comments you have
            posted publicly may remain visible to others until they are deleted. Server logs, which
            include sign-in IP addresses, are kept according to your administrator's system
            configuration.
          </p>
        </Section>

        <Section id="security" title="9. How your information is protected">
          <p>
            Sessions are stored server-side and identified by a signed, HttpOnly cookie. Sign-in
            attempts are rate-limited. Access tokens for your media server are held so the
            application can act on your behalf, which means the security of this data depends on the
            security of the machine it runs on and on your administrator's configuration.
          </p>
          <p>
            No system can be guaranteed secure. If you are concerned about how this particular server
            is secured, ask your administrator before signing in.
          </p>
        </Section>

        <Section id="minors" title="10. Children">
          <p>
            This software is not directed at children, and access is granted by invitation to a
            private media server rather than by open registration. Whether any minor is given an
            account, and on what terms, is a decision for your server administrator and the adult
            responsible for that person.
          </p>
        </Section>

        <Section id="rights" title="11. Your rights">
          <p>
            Depending on where you live, you may have the right to access your information, correct
            it, delete it, obtain a copy of it, object to or restrict its processing, and withdraw
            consent you previously gave.
          </p>
          <p>You can act on much of this yourself, without asking anyone:</p>
          <ul className="legal-list">
            <li><strong>See and change your information</strong> — your profile page and Settings</li>
            <li><strong>Make your reviews private</strong> — Settings → Privacy</li>
            <li><strong>Delete a review or comment</strong> — from the review itself</li>
            <li><strong>Remove notification credentials, including your email address</strong> — clear the field in Settings → Notifications and save</li>
            <li><strong>Withdraw a request or close an issue</strong> — from the Queue and Issues pages</li>
          </ul>
          <p>
            <strong>Deleting your account and its history requires your administrator.</strong> There
            is no self-service account deletion in the application. Ask the person who gave you
            access to this server; they can remove your account and its data. Removing your account
            from the underlying Plex or Jellyfin server also causes Diskovarr to prune it.
          </p>
          <p>
            If you are in the EEA or UK and believe your information is being handled unlawfully, you
            may complain to your national data protection authority.
          </p>
        </Section>

        <Section id="dnt" title="12. Do Not Track">
          <p>
            Diskovarr does not track you across websites, so there is no cross-site tracking for a
            Do Not Track signal to switch off. No such signal is acted on because none is needed.
          </p>
        </Section>

        <Section id="state" title="13. United States state privacy rights">
          <p>
            Residents of California, Virginia, and other states with comparable laws have rights to
            know, access, correct, and delete personal information, and to opt out of its sale or
            sharing and of targeted advertising.
          </p>
          <p>
            <strong>Diskovarr does not sell or share personal information, and does not use it for
            targeted advertising or profiling</strong> — there is nothing to opt out of. The one
            category of sensitive information held is account credentials, in the form of your media
            server access token, which is used solely to operate the service and is never disclosed
            for any other purpose. To exercise the remaining rights, contact your server
            administrator as described below.
          </p>
        </Section>

        <Section id="changes" title="14. Changes to this notice">
          <p>
            This notice may be updated as the software changes. The date at the top reflects the
            last revision, and material changes are noted in the application's changelog.
          </p>
        </Section>

        <Section id="contact" title="15. How to contact us">
          <p>
            <strong>There is no public phone number, email address, or postal address for this
            server, and none is published here.</strong> This is a private server, not a business.
          </p>
          <p>
            For anything about your information on <em>this</em> server — access, correction,
            deletion, or a complaint — contact the administrator who gave you access, through
            whatever channel you already use to reach them. They are the only person who can act on
            these requests.
          </p>
          <p>
            Questions about the Diskovarr <em>software itself</em> — as opposed to your data on this
            server — can be raised on the{' '}
            <a href="https://github.com/Lebbitheplow/diskovarr" target="_blank" rel="noopener noreferrer">
              project's GitHub repository
            </a>. Please do not post personal information there; the maintainers have no access to
            this server or its database.
          </p>
        </Section>
      </main>
    </>
  )
}
