// Audio management for background music and sound effects
// The music starts playing when the player takes control and loops continuously.

const DEFAULT_BGM_VOLUME = 0.33
const DEFAULT_SFX_VOLUME = 0.5

let bgmElement: HTMLAudioElement | null = null
let bgmVolume = DEFAULT_BGM_VOLUME
let bgmNeedsUserGesture = false

let sfxVolume = DEFAULT_SFX_VOLUME
let jetpackSfx: HTMLAudioElement | null = null
let rollingballSfx: HTMLAudioElement | null = null

/**
 * Initialize and start background music.
 * This function is idempotent - calling it multiple times won't restart the music.
 */
export const startBackgroundMusic = () => {
  // Create audio element if it doesn't exist
  if (!bgmElement) {
    bgmElement = new Audio('/backgroundmusic.mp3')
    bgmElement.loop = true
    bgmElement.volume = bgmVolume
  }

  // Start playing only if currently paused
  if (bgmElement.paused) {
    bgmElement.play().catch((err) => {
      // Browser may block autoplay - this is expected and handled gracefully
      console.warn('Background music playback failed (browser may have blocked autoplay):', err)
      bgmNeedsUserGesture = true
    })
  }
}

/**
 * Pause background music.
 */
export const pauseBackgroundMusic = () => {
  if (bgmElement && !bgmElement.paused) {
    bgmElement.pause()
  }
}

/**
 * Resume background music.
 * Returns true if resume was attempted, false if it needs user gesture.
 */
export const resumeBackgroundMusic = (): boolean => {
  if (bgmElement && bgmElement.paused) {
    bgmElement.play().catch((err) => {
      console.warn('Background music playback failed (browser may have blocked autoplay):', err)
      bgmNeedsUserGesture = true
    })
    return true
  }
  return false
}

/**
 * Check if BGM needs a user gesture to resume.
 */
export const bgmNeedsUserInteraction = (): boolean => {
  return bgmNeedsUserGesture
}

/**
 * Attempt to resume BGM after user interaction.
 */
export const tryResumeBackgroundMusicAfterGesture = () => {
  if (bgmNeedsUserGesture && bgmElement && bgmElement.paused) {
    bgmElement.play().then(() => {
      bgmNeedsUserGesture = false
    }).catch((err) => {
      console.warn('Background music resume after gesture failed:', err)
    })
  }
}

/**
 * Set background music volume (0.0 to 1.0).
 */
export const setBackgroundMusicVolume = (volume: number) => {
  const clampedVolume = Math.max(0, Math.min(1, volume))
  bgmVolume = clampedVolume
  if (bgmElement) {
    bgmElement.volume = clampedVolume
  }
}

/**
 * Get current background music volume (0.0 to 1.0).
 */
export const getBackgroundMusicVolume = (): number => {
  return bgmVolume
}

/**
 * Initialize SFX audio elements.
 */
const initSfx = () => {
  if (!jetpackSfx) {
    jetpackSfx = new Audio('/Jetpack.wav')
    jetpackSfx.loop = true
    jetpackSfx.volume = sfxVolume
  }
  if (!rollingballSfx) {
    rollingballSfx = new Audio('/Rollingball.wav')
    rollingballSfx.loop = true
    rollingballSfx.volume = sfxVolume
  }
}

/**
 * Play jetpack sound effect (looping).
 */
export const playJetpackSfx = () => {
  initSfx()
  if (jetpackSfx && jetpackSfx.paused) {
    jetpackSfx.play().catch((err) => {
      console.warn('Jetpack SFX playback failed:', err)
    })
  }
}

/**
 * Stop jetpack sound effect.
 */
export const stopJetpackSfx = () => {
  if (jetpackSfx && !jetpackSfx.paused) {
    jetpackSfx.pause()
  }
}

/**
 * Play rolling ball sound effect (looping).
 */
export const playRollingballSfx = () => {
  initSfx()
  if (rollingballSfx && rollingballSfx.paused) {
    rollingballSfx.play().catch((err) => {
      console.warn('Rolling ball SFX playback failed:', err)
    })
  }
}

/**
 * Stop rolling ball sound effect.
 */
export const stopRollingballSfx = () => {
  if (rollingballSfx && !rollingballSfx.paused) {
    rollingballSfx.pause()
  }
}

/**
 * Set SFX volume (0.0 to 1.0).
 */
export const setSfxVolume = (volume: number) => {
  const clampedVolume = Math.max(0, Math.min(1, volume))
  sfxVolume = clampedVolume
  if (jetpackSfx) {
    jetpackSfx.volume = clampedVolume
  }
  if (rollingballSfx) {
    rollingballSfx.volume = clampedVolume
  }
}

/**
 * Get current SFX volume (0.0 to 1.0).
 */
export const getSfxVolume = (): number => {
  return sfxVolume
}

/**
 * Pause all SFX (used when app loses focus).
 */
export const pauseAllSfx = () => {
  if (jetpackSfx && !jetpackSfx.paused) {
    jetpackSfx.pause()
  }
  if (rollingballSfx && !rollingballSfx.paused) {
    rollingballSfx.pause()
  }
}
