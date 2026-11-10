/** Slow-drifting aurora wash behind everything. Pure CSS, GPU-composited. */
export function Aurora() {
  return (
    <div aria-hidden className="aurora pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute -left-[15%] -top-[25%] h-[70vh] w-[70vh] rounded-full bg-[#ffd9c7] opacity-50 blur-[120px] animate-drift-a" />
      <div className="absolute -right-[10%] top-[10%] h-[60vh] w-[60vh] rounded-full bg-[#e3d6ff] opacity-55 blur-[130px] animate-drift-b" />
      <div className="absolute bottom-[-30%] left-[30%] h-[65vh] w-[65vh] rounded-full bg-[#d4e4ff] opacity-50 blur-[140px] animate-drift-a [animation-delay:-12s]" />
    </div>
  )
}
