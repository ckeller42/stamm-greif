import React from 'react'

import './styles.css'

// Minimal placeholder — replaced by the real frontend in a later task.
// Intentionally static: no user/session data, no environment or file-path info.
export default function HomePage() {
  return (
    <div className="home">
      <div className="content">
        <h1>Stamm-Greif-Archiv</h1>
        <div className="links">
          <a className="admin" href="/admin" rel="noopener noreferrer" target="_blank">
            Zum Admin-Bereich
          </a>
        </div>
      </div>
    </div>
  )
}
