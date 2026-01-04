// Background music management
// The music starts playing when the player takes control and loops continuously.

let audioElement: HTMLAudioElement | null = null
let isPlaying = false

/**
 * Initialize and start background music.
 * This function is idempotent - calling it multiple times won't restart the music.
 */
export const startBackgroundMusic = () => {
  // If already playing, do nothing
  if (isPlaying && audioElement && !audioElement.paused) {
    return
  }

  // Create audio element if it doesn't exist
  if (!audioElement) {
    audioElement = new Audio('/backgroundmusic.mp3')
    audioElement.loop = true
    audioElement.volume = 0.5 // Set a reasonable default volume
  }

  // Start playing
  if (audioElement.paused) {
    audioElement.play().catch((err) => {
      // Browser may block autoplay - this is expected and handled gracefully
      console.warn('Background music playback failed:', err)
    })
    isPlaying = true
  }
}
