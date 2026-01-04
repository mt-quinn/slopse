// Audio management using Howler.js for reliable, cross-browser audio playback
// Howler.js provides robust volume control and seamless looping

import { Howl } from 'howler'

const DEFAULT_BGM_VOLUME = 0.33
const DEFAULT_SFX_VOLUME = 0.5

// Load persisted volumes from localStorage or use defaults
const loadBgmVolume = (): number => {
  try {
    const saved = localStorage.getItem('slopes-bgm-volume')
    if (saved !== null) {
      const parsed = parseFloat(saved)
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        return parsed
      }
    }
  } catch {
    // localStorage might not be available
  }
  return DEFAULT_BGM_VOLUME
}

const loadSfxVolume = (): number => {
  try {
    const saved = localStorage.getItem('slopes-sfx-volume')
    if (saved !== null) {
      const parsed = parseFloat(saved)
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        return parsed
      }
    }
  } catch {
    // localStorage might not be available
  }
  return DEFAULT_SFX_VOLUME
}

let bgmVolume = loadBgmVolume()
let bgmNeedsUserGesture = false

let sfxVolume = loadSfxVolume()

// Howler audio instances
let bgmSound: Howl | null = null
let jetpackSound: Howl | null = null
let rollingballSound: Howl | null = null

/**
 * Initialize and start background music using Howler.js
 */
export const startBackgroundMusic = () => {
  // Create Howler instance if it doesn't exist
  if (!bgmSound) {
    bgmSound = new Howl({
      src: ['/backgroundmusic.mp3'],
      loop: true,
      volume: bgmVolume,
      // Use Web Audio API for better volume control (html5: false is default)
    })
  } else {
    // Update volume to current setting
    bgmSound.volume(bgmVolume)
  }

  // Start playing only if not already playing
  if (!bgmSound.playing()) {
    bgmSound.play()
    bgmSound.once('playerror', () => {
      bgmNeedsUserGesture = true
    })
  }
}

/**
 * Pause background music
 */
export const pauseBackgroundMusic = () => {
  if (bgmSound && bgmSound.playing()) {
    bgmSound.pause()
  }
}

/**
 * Resume background music
 */
export const resumeBackgroundMusic = (): boolean => {
  if (bgmSound && !bgmSound.playing()) {
    bgmSound.play()
    return true
  }
  return false
}

/**
 * Check if BGM needs a user gesture to resume
 */
export const bgmNeedsUserInteraction = (): boolean => {
  return bgmNeedsUserGesture
}

/**
 * Attempt to resume BGM after user interaction
 */
export const tryResumeBackgroundMusicAfterGesture = () => {
  if (bgmNeedsUserGesture && bgmSound && !bgmSound.playing()) {
    bgmSound.play()
    bgmSound.once('play', () => {
      bgmNeedsUserGesture = false
    })
  }
}

/**
 * Set background music volume (0.0 to 1.0) - REAL-TIME UPDATE
 */
export const setBackgroundMusicVolume = (volume: number) => {
  const clampedVolume = Math.max(0, Math.min(1, volume))
  bgmVolume = clampedVolume
  
  // Persist to localStorage
  try {
    localStorage.setItem('slopes-bgm-volume', String(clampedVolume))
  } catch {
    // localStorage might not be available
  }
  
  // CRITICAL: Update Howler volume immediately - this updates in real-time
  if (bgmSound) {
    bgmSound.volume(clampedVolume)
  }
}

/**
 * Get current background music volume (0.0 to 1.0)
 */
export const getBackgroundMusicVolume = (): number => {
  return bgmVolume
}

/**
 * Initialize SFX Howler instances
 */
const initSfx = () => {
  if (!jetpackSound) {
    jetpackSound = new Howl({
      src: ['/Jetpack.wav'],
      loop: true,
      volume: sfxVolume,
    })
  } else {
    jetpackSound.volume(sfxVolume)
  }
  
  if (!rollingballSound) {
    rollingballSound = new Howl({
      src: ['/Rollingball.wav'],
      loop: true,
      volume: sfxVolume,
    })
  } else {
    rollingballSound.volume(sfxVolume)
  }
}

/**
 * Play jetpack sound effect (looping)
 */
export const playJetpackSfx = () => {
  initSfx()
  if (jetpackSound && !jetpackSound.playing()) {
    jetpackSound.play()
  }
}

/**
 * Stop jetpack sound effect
 */
export const stopJetpackSfx = () => {
  if (jetpackSound && jetpackSound.playing()) {
    jetpackSound.pause()
  }
}

/**
 * Play rolling ball sound effect (looping)
 */
export const playRollingballSfx = () => {
  initSfx()
  if (rollingballSound && !rollingballSound.playing()) {
    rollingballSound.play()
  }
}

/**
 * Stop rolling ball sound effect
 */
export const stopRollingballSfx = () => {
  if (rollingballSound && rollingballSound.playing()) {
    rollingballSound.pause()
  }
}

/**
 * Set SFX volume (0.0 to 1.0) - REAL-TIME UPDATE
 */
export const setSfxVolume = (volume: number) => {
  const clampedVolume = Math.max(0, Math.min(1, volume))
  sfxVolume = clampedVolume
  
  // Persist to localStorage
  try {
    localStorage.setItem('slopes-sfx-volume', String(clampedVolume))
  } catch {
    // localStorage might not be available
  }
  
  // CRITICAL: Update Howler volumes immediately - this updates in real-time
  if (jetpackSound) {
    jetpackSound.volume(clampedVolume)
  }
  if (rollingballSound) {
    rollingballSound.volume(clampedVolume)
  }
}

/**
 * Get current SFX volume (0.0 to 1.0)
 */
export const getSfxVolume = (): number => {
  return sfxVolume
}

/**
 * Pause all SFX (used when app loses focus)
 */
export const pauseAllSfx = () => {
  if (jetpackSound && jetpackSound.playing()) {
    jetpackSound.pause()
  }
  if (rollingballSound && rollingballSound.playing()) {
    rollingballSound.pause()
  }
}
