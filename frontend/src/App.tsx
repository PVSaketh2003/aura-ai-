import { AnimatePresence, motion } from 'motion/react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Aurora } from './components/Aurora'
import { Orb } from './components/Orb'
import { ToastProvider } from './components/ui'
import { AgentProvider } from './context/AgentContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AppLayout } from './layouts/AppLayout'
import { AuthPage } from './pages/AuthPage'
import { ChatPage } from './pages/ChatPage'
import { GalaxyPage } from './pages/GalaxyPage'
import { VoiceTrainPage } from './pages/VoiceTrainPage'
import { LibraryPage } from './pages/LibraryPage'
import { MemoryPage } from './pages/MemoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { MessengerPage } from './pages/MessengerPage'
import { MessengerProvider } from './context/MessengerContext'
import { CallOverlay } from './components/messenger/bits'

function Gate() {
  const { user, loading } = useAuth()
  return (
    <AnimatePresence mode="wait">
      {loading ? (
        <motion.div key="l" exit={{ opacity: 0 }} className="relative z-10 grid h-full place-items-center"><Orb size={64} mode="thinking" /></motion.div>
      ) : !user ? (
        <motion.div key="a" className="h-full" exit={{ opacity: 0 }}><AuthPage /></motion.div>
      ) : (
        <motion.div key="app" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <AgentProvider>
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
