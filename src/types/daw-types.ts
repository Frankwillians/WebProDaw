/**
 * DAW Data Types - Fase 1: Arquitetura
 * Define a estrutura inicial de Projeto, Canal e Clipe de Áudio
 */

// Audio Clip representation
export interface AudioClip {
  id: string;
  url: string; // URL or path to the audio file
  startTime: number; // Position in seconds within the timeline
  endTime: number; // Duration in seconds
  gain: number; // Volume gain (0.0 to 1.0)
  muted: boolean;
  solo: boolean;
  color: string; // UI color for the clip
}

// Channel (Track) representation
export interface Channel {
  id: string;
  name: string;
  color: string;
  muted: boolean;
  solo: boolean;
  armForRecord: boolean;
  volume: number; // -∞ to 0 dB, represented as 0.0 to 1.0 linear or normalized
  pan: number; // -1.0 (left) to 1.0 (right)
  clips: AudioClip[];
  fxChain: string[]; // IDs of plugins/effects in the chain
  inputRouting: string; // Bus or input name
  outputRouting: string; // Bus name (e.g., "Master", "Bus 1")
}

// Project representation - contains all state
export interface Project {
  id: string;
  name: string;
  created: number; // timestamp in ms
  modified: number; // timestamp in ms
  tempo: number; // BPM
  timeSignature: [number, number]; // e.g., [4, 4]
  channels: Channel[];
  selectedChannelId: string | null;
  globalGain: number; // Master volume (0.0 to 1.0)
  // Metadata for file I/O
  metadata: {
    sampleRate: number;
    bitDepth: number;
    format: 'wav' | 'mp3' | 'ogg';
  };
}

// Project Store interface - for state management
export interface ProjectStore {
  project: Project;
  setProject: (project: Partial<Project>) => void;
  addChannel: (channel: Omit<Channel, 'id'>) => string;
  removeChannel: (channelId: string) => void;
  updateChannel: (channelId: string, updates: Partial<Channel>) => void;
  addClip: (channelId: string, clip: Omit<AudioClip, 'id'>) => void;
  removeClip: (channelId: string, clipId: string) => void;
  selectChannel: (channelId: string | null) => void;
  saveProject: () => Promise<string>; // Returns JSON string or Blob URL
  loadProject: (json: string) => void;
}