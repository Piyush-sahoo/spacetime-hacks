import { useCallback, useEffect, useRef, useState } from 'react'
import '../funnel.css'
import { projectsLink, SITE } from '../lib/funnel'

/**
 * One block of copyable text: the text itself, and a button that copies it.
 *
 * `label` is what the button says once it has copied, so a person gets a real
 * confirmation rather than a state change they have to guess at. The clipboard
 * API is not available on an insecure origin, so the fallback is to select the
 * text — which is worse, and says so, rather than silently doing nothing.
 */
export function Copy({ text, title }) {
  const [state, setState] = useState('idle') // idle | done | manual
  const preRef = useRef(null)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = useCallback(async () => {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(text)
      setState('done')
    } catch {
      // No clipboard permission (or an insecure origin). Select it instead so
      // the person can still take it with one keystroke.
      try {
        const range = document.createRange()
        range.selectNodeContents(preRef.current)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      } catch { /* nothing left to try */ }
      setState('manual')
    }
    timer.current = setTimeout(() => setState('idle'), 2000)
  }, [text])

  return (
    <div className="fn-copy">
      <pre ref={preRef} aria-label={title}>{text}</pre>
      <button
        type="button"
        onClick={copy}
        className={state === 'done' ? 'on' : undefined}
        aria-label={`Copy ${title || 'to clipboard'}`}
      >
        {state === 'done' ? 'Copied' : state === 'manual' ? 'Selected' : 'Copy'}
      </button>
    </div>
  )
}

/** Every route out of the funnel is a real navigation, so back and share work. */
export const go = (href) => { window.location.href = href }

/** The page chrome every funnel page shares. */
export function Shell({ children, nav, narrow }) {
  return (
    <div className="fn">
      <header className="fn-top">
        <a
          className="fn-mark"
          href={SITE + '/'}
          style={{ textDecoration: 'none' }}
        >The Map Room</a>
        <span className="micro-label" style={{ whiteSpace: 'nowrap' }}>SPACETIMEDB · LIVE</span>
        <span className="fn-spacer" />
        <nav className="fn-nav">
          {nav}
          <button type="button" className="ctl" onClick={() => go(projectsLink())}>
            Projects
          </button>
        </nav>
      </header>

      <main className="fn-main">
        <div className={narrow ? 'fn-wrap fn-narrow' : 'fn-wrap'}>{children}</div>
      </main>

      <footer className="fn-foot">
        <span>Bounded backwards walk · k=6 · threshold 0.95</span>
        <span>SWE-bench Verified · 172 labelled fixes · 7 repositories</span>
      </footer>
    </div>
  )
}

/** A numbered step in a walkthrough. The number is the point. */
export function Step({ n, title, why, children, expect }) {
  return (
    <li className="fn-step">
      <div className="fn-head">
        <span className="fn-no fn-num">{n}</span>
        <span className="fn-title">{title}</span>
      </div>
      {why && <p className="fn-why">{why}</p>}
      {children}
      {expect && <p className="fn-expect">{expect}</p>}
    </li>
  )
}
