import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'
import { installApiBridge } from './services/apiBase'

installApiBridge()

// Aura is light-only.
document.documentElement.dataset.theme = 'light'
try { localStorage.removeItem('aura.theme') } catch { /* private mode */ }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
