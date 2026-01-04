// Background music management
// The music starts playing when the player takes control and loops continuously.

const DEFAULT_VOLUME = 0.5

let audioElement: HTMLAudioElement | null = null

/**
 * Initialize and start background music.
 * This function is idempotent - calling it multiple times won't restart the music.
 */
export const startBackgroundMusic = () => {
  // Create audio element if it doesn't exist
  if (!audioElement) {
    audioElement = new Audio('/backgroundmusic.mp3')
    audioElement.loop = true
    audioElement.volume = DEFAULT_VOLUME
  }

  // Start playing only if currently paused
  if (audioElement.paused) {
    audioElement.play().catch((err) => {
      // Browser may block autoplay - this is expected and handled gracefully
      console.warn('Background music playback failed (browser may have blocked autoplay):', err)
    })
  }
}

/**
 * Pause background music.
 */
export const pauseBackgroundMusic = () => {
  if (audioElement && !audioElement.paused) {
    audioElement.pause()
  }
}

/**
 * Resume background music.
 */
export const resumeBackgroundMusic = () => {
  if (audioElement && audioElement.paused) {
    audioElement.play().catch((err) => {
      console.warn('Background music playback failed (browser may have blocked autoplay):', err)
    })
  }
}

/**
 * Set background music volume (0.0 to 1.0).
 */
export const setBackgroundMusicVolume = (volume: number) => {
  const clampedVolume = Math.max(0, Math.min(1, volume))
  if (audioElement) {
    audioElement.volume = clampedVolume
  }
}

/**
 * Get current background music volume (0.0 to 1.0).
 */
export const getBackgroundMusicVolume = (): number => {
  return audioElement?.volume ?? DEFAULT_VOLUME
}
