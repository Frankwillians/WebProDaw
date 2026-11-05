/**
 * DAW Data Types - Complete Project Structure
 * Supports audio/MIDI clips, automation, buses, tempo map, and full project serialization
 */

// ============================================================
// Core Types
// ============================================================

export type ClipType = 'audio' | 'midi';
export type AutomationTarget = 
  | 'volume' 
  | 'pan' 
  | 'mute' 
  | 'solo'
  | `fx:${string}:${string}`  // fx:trackId:paramName
  | `plugin:${string}:${string}`; // plugin:pluginId:paramName

export interface Point {
  x: number; // time in beats (quarter notes)
  y: number; // normalized value 0-1
  shape?: 'linear' | 'bezier' | 'step' | 'hold';
  tension?: number; // for bezier curves
}

// ============================================================
// Clip Types
// ============================================================

export interface BaseClip {
  id: string;
  type: ClipType;
  name: string;
  color: string;
  startBeat: number; // position in beats (quarter notes)
  durationBeats: number; // length in beats
  gain: number; // 0-1
  muted: boolean;
  solo: boolean;
  locked: boolean; // prevent accidental edits
  fadeIn: number; // beats
  fadeOut: number; // beats
  loopEnabled: boolean;
  loopStart: number; // beats from clip start
  loopEnd: number; // beats from clip start
  reverse: boolean;
  timeStretch: number; // ratio (0.25 - 4.0)
  pitchShift: number; // semitones (-24 to +24)
}

export interface AudioClip extends BaseClip {
  type: 'audio';
  audioBufferId: string; // reference to stored AudioBuffer
  waveformPeaks: number[]; // precomputed for display
  channels: 1 | 2;
  sampleRate: number;
  originalDuration: number; // seconds
}

export interface MidiClip extends BaseClip {
  type: 'midi';
  notes: MidiNote[];
  controllerData: Map<string, ControllerEvent[]>; // CC#, pitch bend, etc.
  programChange?: number;
  channel: number; // 0-15
}

export interface MidiNote {
  id: string;
  pitch: number; // 0-127
  velocity: number; // 0-127
  startBeat: number; // relative to clip start
  durationBeats: number;
  channel: number; // 0-15
  muted: boolean;
}

export interface ControllerEvent {
  beat: number; // relative to clip start
  value: number; // 0-127 (or -8192 to 8191 for pitch bend)
}

export type Clip = AudioClip | MidiClip;

export function isAudioClip(clip: Clip): clip is AudioClip {
  return clip.type === 'audio';
}

export function isMidiClip(clip: Clip): clip is MidiClip {
  return clip.type === 'midi';
}

// ============================================================
// Track/Channel Types
// ============================================================

export interface TrackFxState {
  enabled: boolean;
  params: Record<string, number>;
}

export interface TrackPlugin {
  id: string;
  name: string;
  kind: 'ir' | 'worklet' | 'nam';
  enabled: boolean;
  params: Record<string, number>;
  // Serialized plugin data
  irBufferId?: string;
  workletSource?: string;
  processorName?: string;
  namJson?: string;
  namSlim?: number;
}

export interface TrackSend {
  id: string;
  targetBusId: string;
  level: number; // 0-1
  pan: number; // -1 to 1
  preFader: boolean;
  enabled: boolean;
}

export interface TrackAutomation {
  target: AutomationTarget;
  points: Point[];
  visible: boolean;
  color: string;
}

export interface Channel {
  id: string;
  name: string;
  color: string;
  type: 'audio' | 'midi' | 'bus' | 'master';
  muted: boolean;
  solo: boolean;
  soloSafe: boolean;
  armForRecord: boolean;
  inputMonitor: boolean;
  volume: number; // 0-1.5 (linear gain)
  pan: number; // -1 to 1
  width: number; // 0-1 (stereo width)
  clips: Clip[];
  fxChain: TrackPlugin[];
  fxRack: Record<string, TrackFxState>; // builtin FX by ID
  sends: TrackSend[];
  automation: TrackAutomation[];
  inputDeviceId?: string;
  outputBusId: string; // bus ID or 'master'
  // MIDI
  midiInputId?: string;
  midiChannel?: number; // 0-15, or -1 for omni
  // Visual
  height: number; // track height in pixels
  minimized: boolean;
  folderTrackId?: string; // for track folders
  isFolder: boolean;
  folderExpanded: boolean;
}

// ============================================================
// Bus/Group Types
// ============================================================

export interface Bus {
  id: string;
  name: string;
  color: string;
  type: 'aux' | 'group' | 'vca' | 'master';
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  fxChain: TrackPlugin[];
  fxRack: Record<string, TrackFxState>;
  sends: TrackSend[]; // sends to other buses
  inputChannelIds: string[]; // channels routed to this bus
  automation: TrackAutomation[];
}

// ============================================================
// Tempo & Time Signature
// ============================================================

export interface TempoPoint {
  beat: number; // position in beats from start
  bpm: number; // tempo in BPM
  shape: 'step' | 'ramp'; // sudden change or gradual
}

export interface TimeSigPoint {
  beat: number;
  numerator: number;
  denominator: number; // 1, 2, 4, 8, 16
}

// ============================================================
// Marker/Region Types
// ============================================================

export interface Marker {
  id: string;
  name: string;
  beat: number;
  color: string;
  isRegion: boolean;
  regionEndBeat?: number;
  locked: boolean;
  annotation?: string;
}

// ============================================================
// Project Types
// ============================================================

export interface ProjectMetadata {
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
  format: 'wav' | 'flac' | 'ogg';
  version: number; // file format version
  created: number;
  modified: number;
  author?: string;
  description?: string;
  tags?: string[];
}

export interface ProjectSettings {
  // Audio
  masterVolume: number;
  masterMuted: boolean;
  // Transport
  loopEnabled: boolean;
  loopStartBeat: number;
  loopEndBeat: number;
  metronomeEnabled: boolean;
  metronomeSound: 'click' | 'beep' | 'wood' | 'custom';
  metronomeVolume: number;
  countInBars: number;
  // Recording
  recordFileFormat: 'wav' | 'flac';
  recordBitDepth: 16 | 24 | 32;
  autoCreateTakeFolders: boolean;
  // Grid
  snapEnabled: boolean;
  snapDivision: number; // 1/4, 1/8, 1/16, 1/32, 1/64, 'triplet'
  // UI
  theme: 'dark' | 'light' | 'auto';
  showWaveforms: boolean;
  showMidiNotes: boolean;
  rulerFormat: 'beats' | 'time' | 'samples' | 'timecode';
}

export interface AudioBufferRef {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  peaks: number[];
  // The actual AudioBuffer is stored in IndexedDB/OPFS, not in JSON
}

export interface Project {
  id: string;
  name: string;
  metadata: ProjectMetadata;
  settings: ProjectSettings;
  // Tracks ordered by position
  tracks: Channel[];
  buses: Bus[];
  // Global tempo map
  tempoMap: TempoPoint[];
  // Time signature map
  timeSigMap: TimeSigPoint[];
  // Markers & regions
  markers: Marker[];
  // Audio buffer references (actual buffers in IndexedDB)
  audioBuffers: AudioBufferRef[];
  // Undo history (serialized actions)
  undoHistory: UndoAction[];
  undoIndex: number;
}

export interface UndoAction {
  id: string;
  type: string;
  timestamp: number;
  description: string;
  // Serialized state delta
  data: unknown;
  // For redo support
  inverseData?: unknown;
}

// ============================================================
// Store Interface
// ============================================================

export interface ProjectStore {
  project: Project | null;
  // Project lifecycle
  newProject: (name?: string, template?: string) => Promise<void>;
  loadProject: (file: File | string) => Promise<void>;
  saveProject: (path?: string) => Promise<void>;
  saveProjectAs: (file: File) => Promise<void>;
  exportProject: () => Promise<Blob>;
  importProject: (blob: Blob) => Promise<void>;
  // Track management
  addTrack: (track: Omit<Channel, 'id'>) => string;
  removeTrack: (trackId: string) => void;
  duplicateTrack: (trackId: string) => string;
  moveTrack: (trackId: string, newIndex: number) => void;
  updateTrack: (trackId: string, updates: Partial<Channel>) => void;
  // Clip management
  addClip: (trackId: string, clip: Omit<Clip, 'id'>) => string;
  removeClip: (trackId: string, clipId: string) => void;
  updateClip: (trackId: string, clipId: string, updates: Partial<Clip>) => void;
  splitClip: (trackId: string, clipId: string, beat: number) => [string, string];
  // Automation
  addAutomationPoint: (trackId: string, target: AutomationTarget, point: Point) => void;
  removeAutomationPoint: (trackId: string, target: AutomationTarget, pointIndex: number) => void;
  setAutomationPoints: (trackId: string, target: AutomationTarget, points: Point[]) => void;
  // Tempo/TimeSig
  setTempoAt: (beat: number, bpm: number, shape?: 'step' | 'ramp') => void;
  setTimeSigAt: (beat: number, numerator: number, denominator: number) => void;
  // Markers
  addMarker: (marker: Omit<Marker, 'id'>) => string;
  removeMarker: (markerId: string) => void;
  updateMarker: (markerId: string, updates: Partial<Marker>) => void;
  // Audio buffers (IndexedDB/OPFS)
  storeAudioBuffer: (buffer: AudioBuffer, name: string) => Promise<string>;
  getAudioBuffer: (bufferId: string) => Promise<AudioBuffer | null>;
  deleteAudioBuffer: (bufferId: string) => Promise<void>;
  // Undo/Redo
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  // Selection
  selection: SelectionState;
  setSelection: (selection: SelectionState) => void;
  // UI State
  uiState: UIState;
  setUIState: (state: Partial<UIState>) => void;
}

export interface SelectionState {
  tracks: string[];
  clips: string[]; // trackId:clipId
  automationPoints: string[]; // trackId:target:pointIndex
  timeRange?: { startBeat: number; endBeat: number };
}

export interface UIState {
  // Timeline
  zoomLevel: number; // beats per pixel
  scrollX: number; // beat position
  scrollY: number; // track index
  // Panels
  showMixer: boolean;
  showBrowser: boolean;
  showInspector: boolean;
  showAutomation: boolean;
  activeTab: 'arrangement' | 'mixer' | 'browser' | 'inspector';
  // Track heights
  trackHeights: Record<string, number>;
  // Playhead
  playheadBeat: number;
  // Loop region
  loopStartBeat: number;
  loopEndBeat: number;
}