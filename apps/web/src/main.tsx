import './index.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import ReactLogo from './assets/react.svg' // ensure this file exists

function App() {
  return (
    <div>
      <h1>Booking App 🚀</h1>
      <img src={ReactLogo} alt="React Logo" width={100} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
