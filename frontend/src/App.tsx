import { AnimatePresence, motion } from 'motion/react'
import { lazy } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Aurora } from './components/Aurora'
import { Orb } from './components/Orb'
import { ToastProvider } from './components/ui'
import { AgentProvider } from './context/AgentContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AppLayout } from './layouts/AppLayout'
import { AuthPage } from './pages/AuthPage'
import { OfflinePage } from './pages/OfflinePage'
const ChatPage = lazy(() => import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })))
const GalaxyPage = lazy(() => import('./pages/GalaxyPage').then((m) => ({ default: m.GalaxyPage })))
const VoiceTrainPage = lazy(() => import('./pages/VoiceTrainPage').then((m) => ({ default: m.VoiceTrainPage })))
const LibraryPage = lazy(() => import('./pages/LibraryPage').then((m) => ({ default: m.LibraryPage })))
const MemoryPage = lazy(() => import('./pages/MemoryPage').then((m) => ({ default: m.MemoryPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const MessengerPage = lazy(() => import('./pages/MessengerPage').then((m) => ({ default: m.MessengerPage })))
import { MessengerProvider } from './context/MessengerContext'
import { NotificationProvider } from './context/NotificationContext'
import { CallOverlay } from './components/messenger/bits'

function Gate() {
  const { user, loading, offline } = useAuth()
  return (
    <AnimatePresence mode="wait">
      {loading ? (
        <motion.div key="l" exit={{ opacity: 0 }} className="relative z-10 grid h-full place-items-center"><Orb size={64} mode="thinking" /></motion.div>
      ) : offline && !user ? (
        <motion.div key="o" className="h-full" exit={{ opacity: 0 }}><OfflinePage /></motion.div>
      ) : !user ? (
        <motion.div key="a" className="h-full" exit={{ opacity: 0 }}><AuthPage /></motion.div>
      ) : (
        <motion.div key="app" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <AgentProvider>
           <NotificationProvider>
           <MessengerProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route index element={<ChatPage />} />
                <Route path="library" element={<LibraryPage />} />
                <Route path="galaxy" element={<GalaxyPage />} />
                <Route path="voice" element={<VoiceTrainPage />} />
                <Route path="memory" element={<MemoryPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="messenger" element={<MessengerPage />} />
              </Route>
            </Routes>
            <CallOverlay />
           </MessengerProvider>
           </NotificationProvider>
          </AgentProvider>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <div className="grain relative h-full overflow-hidden">
            <Aurora />
            <Gate />
          </div>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
