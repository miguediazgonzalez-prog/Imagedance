/** Canciones incluidas (sintetizadas para esta app: sin derechos). Todas empiezan justo en un beat (t = 0), así que el compás es exacto. */
export interface Track { id: string; name: string; emoji: string; bpm: number; file: string }
export const TRACKS: Track[] = [
  { id: 'disco', name: 'Disco Noches', emoji: '🪩', bpm: 118, file: 'disco-noches.mp3' },
  { id: 'house', name: 'House Party', emoji: '🎧', bpm: 124, file: 'house-party.mp3' },
  { id: 'reggaeton', name: 'Reggaetón', emoji: '🔥', bpm: 96, file: 'reggaeton-vibes.mp3' },
  { id: 'pop', name: 'Pop Dance', emoji: '⭐', bpm: 110, file: 'pop-dance.mp3' },
  { id: 'techno', name: 'Techno Pulse', emoji: '⚡', bpm: 130, file: 'techno-pulse.mp3' },
  { id: 'funk', name: 'Funk Groove', emoji: '🕺', bpm: 104, file: 'funk-groove.mp3' }
]
export const trackUrl = (t: Track) => `${import.meta.env.BASE_URL}music/${t.file}`
