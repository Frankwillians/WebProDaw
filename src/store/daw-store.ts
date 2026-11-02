/**
 * Project Store - Simple implementation using React Context patterns
 * This will be integrated with the full state management system in later phases
 */

import type { Project, AudioClip, Channel, ProjectStore } from '../types/daw-types';

// Initialize with a default project
const defaultProject: Project = {
  id: 'project-1',
  name: 'Meu Projeto DAW',
  created: Date.now(),
  modified: Date.now(),
  tempo: 120,
  timeSignature: [4, 4],
  channels: [],
  selectedChannelId: null,
  globalGain: 1.0,
  metadata: {
    sampleRate: 44100,
    bitDepth: 16,
    format: 'wav',
  },
};

export const defaultStore: ProjectStore = {
  project: { ...defaultProject },
  setProject: (project) => {
    // In a real implementation, this would update state and trigger re-renders
    Object.assign(defaultStore.project, project);
    defaultStore.project.modified = Date.now();
  },
  addChannel: (channel) => {
    const newChannel: Channel = {
      id: `channel-${Date.now()}`,
      name: channel.name || `Track ${defaultStore.project.channels.length + 1}`,
      color: channel.color || `#${Math.floor(Math.random()*16777215).toString(16)}`,
      muted: false,
      solo: false,
      armForRecord: false,
      volume: 1.0,
      pan: 0,
      clips: [],
      fxChain: [],
      inputRouting: 'Input',
      outputRouting: 'Master',
    };
    defaultStore.project.channels.push(newChannel);
    defaultStore.project.modified = Date.now();
    return newChannel.id;
  },
  removeChannel: (channelId) => {
    defaultStore.project.channels = defaultStore.project.channels.filter(c => c.id !== channelId);
    if (defaultStore.project.selectedChannelId === channelId) {
      defaultStore.project.selectedChannelId = null;
    }
    defaultStore.project.modified = Date.now();
  },
  updateChannel: (channelId, updates) => {
    const channel = defaultStore.project.channels.find(c => c.id === channelId);
    if (channel) {
      Object.assign(channel, updates);
      defaultStore.project.modified = Date.now();
    }
  },
  addClip: (channelId, clip) => {
    const channel = defaultStore.project.channels.find(c => c.id === channelId);
    if (channel) {
      const newClip: AudioClip = {
        id: `clip-${Date.now()}`,
        url: clip.url || '',
        startTime: clip.startTime ?? 0,
        endTime: clip.endTime ?? 4,
        gain: clip.gain ?? 1.0,
        muted: false,
        solo: false,
        color: clip.color || channel.color,
      };
      channel.clips.push(newClip);
      defaultStore.project.modified = Date.now();
    }
  },
  removeClip: (channelId, clipId) => {
    const channel = defaultStore.project.channels.find(c => c.id === channelId);
    if (channel) {
      channel.clips = channel.clips.filter(c => c.id !== clipId);
      defaultStore.project.modified = Date.now();
    }
  },
  selectChannel: (channelId) => {
    defaultStore.project.selectedChannelId = channelId;
  },
  saveProject: async () => {
    // In a real implementation, this would save to IndexedDB/OPFS
    const blob = new Blob([JSON.stringify(defaultStore.project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    return url;
  },
  loadProject: (json) => {
    const parsed = JSON.parse(json);
    Object.assign(defaultStore.project, parsed);
    defaultStore.project.created = Date.now();
    defaultStore.project.modified = Date.now();
  },
};

export default defaultStore;