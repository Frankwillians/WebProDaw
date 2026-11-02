// AudioWorklet Processor - Web Audio API Low Latency Processing
// This file is loaded by: audioContext.audioWorklet.addModule('/audio/audio-worklet-processor.js')

// Handle messages from the main thread
self.onmessage = function (event) {
  const message = event.data;

  if (!message || typeof message !== 'object') return;
  if (!message.type) return;

  switch (message.type) {
    case 'setVolume':
      // Initialize channel state if not exists
      if (!self.channelStateMap) self.channelStateMap = new Map();
      if (!self.channelStateMap.has(message.channelId)) {
        self.channelStateMap.set(message.channelId, {
          volume: 1.0,
          pan: 0,
          muted: false,
          solo: false,
          clips: [],
          armForRecord: false,
        });
      }
      const volState = self.channelStateMap.get(message.channelId);
      if (volState) {
        volState.volume = Math.max(0, Math.min(1, message.volume));
      }
      break;

    case 'setPan':
      if (!self.channelStateMap) self.channelStateMap = new Map();
      if (!self.channelStateMap.has(message.channelId)) {
        self.channelStateMap.set(message.channelId, {
          volume: 1.0,
          pan: 0,
          muted: false,
          solo: false,
          clips: [],
          armForRecord: false,
        });
      }
      const panState = self.channelStateMap.get(message.channelId);
      if (panState) {
        panState.pan = Math.max(-1, Math.min(1, message.pan));
      }
      break;

    case 'setMute':
      if (!self.channelStateMap) self.channelStateMap = new Map();
      if (!self.channelStateMap.has(message.channelId)) {
        self.channelStateMap.set(message.channelId, {
          volume: 1.0,
          pan: 0,
          muted: false,
          solo: false,
          clips: [],
          armForRecord: false,
        });
      }
      const muteState = self.channelStateMap.get(message.channelId);
      if (muteState) {
        muteState.muted = message.muted;
      }
      break;

    case 'setSolo':
      if (!self.channelStateMap) self.channelStateMap = new Map();
      if (!self.channelStateMap.has(message.channelId)) {
        self.channelStateMap.set(message.channelId, {
          volume: 1.0,
          pan: 0,
          muted: false,
          solo: false,
          clips: [],
          armForRecord: false,
        });
      }
      const soloState = self.channelStateMap.get(message.channelId);
      if (soloState) {
        soloState.solo = message.solo;
      }
      break;

    case 'setClipData':
      if (!self.channelStateMap) self.channelStateMap = new Map();
      if (!self.channelStateMap.has(message.channelId)) {
        self.channelStateMap.set(message.channelId, {
          volume: 1.0,
          pan: 0,
          muted: false,
          solo: false,
          clips: [],
          armForRecord: false,
        });
      }
      const clipState = self.channelStateMap.get(message.channelId);
      if (clipState) {
        const existing = clipState.clips.find(c => c.url === message.url);
        if (!existing) {
          clipState.clips.push({
            url: message.url,
            startTime: message.startTime ?? 0,
            endTime: message.endTime ?? 4,
          });
        }
      }
      break;

    case 'toggleRecord':
      if (!self.channelStateMap) self.channelStateMap = new Map();
      if (!self.channelStateMap.has(message.channelId)) {
        self.channelStateMap.set(message.channelId, {
          volume: 1.0,
          pan: 0,
          muted: false,
          solo: false,
          clips: [],
          armForRecord: false,
        });
      }
      const recState = self.channelStateMap.get(message.channelId);
      if (recState) {
        recState.armForRecord = message.armForRecord;
      }
      break;
  }
}

// AudioWorklet Processor class - handles per-frame audio processing
class ChannelProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    // Get the first input channel
    const inputChannel = inputs[0];
    const outputChannel = outputs[0];

    // Determine frame count
    const frameCount = inputChannel ? inputChannel.length : 0;

    // Initialize output to silence (stereo: left + right)
    if (outputChannel) {
      for (let i = 0; i < frameCount; i++) {
        outputChannel[i] = 0; // left channel
        outputChannel[i + frameCount] = 0; // right channel
      }
    }

    // If no input, return silence
    if (!inputChannel || frameCount === 0) {
      return true;
    }

    // Get channel state - use input index as channel identifier
    // In a production DAW, this would use a proper mapping
    const channelId = 'channel-0'; // Simplified for now
    if (!self.channelStateMap) self.channelStateMap = new Map();
    if (!self.channelStateMap.has(channelId)) {
      self.channelStateMap.set(channelId, {
        volume: 1.0,
        pan: 0,
        muted: false,
        solo: false,
        clips: [],
        armForRecord: false,
      });
    }
    const state = self.channelStateMap.get(channelId);

    // Skip muted channels - output silence
    if (!state || state.muted) {
      // Already filled with silence above
      return true;
    }

    // Process each sample frame
    for (let frame = 0; frame < frameCount; frame++) {
      let sample = inputChannel[frame];

      // Apply volume gain
      sample *= state.volume;

      // Apply simple AB pan law
      const pan = state.pan;
      const leftGain = Math.max(0, Math.min(1, (1 - pan) / 2));
      const rightGain = Math.max(0, Math.min(1, (1 + pan) / 2));

      // Fill stereo output channels
      if (outputChannel) {
        outputChannel[frame] += sample * leftGain; // left
        outputChannel[frame + frameCount] += sample * rightGain; // right
      }
    }

    return true; // Continue processing
  }
}

// Register the processor name so it can be used in the main thread
// when creating the AudioWorkletNode
registerProcessor('channel-processor', ChannelProcessor);