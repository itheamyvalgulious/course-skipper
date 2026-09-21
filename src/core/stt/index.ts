export * from './types';
export * from './baseSTTProvider';
export * from './googleCloudSTTProvider';
export * from './localCpuSTTProvider';
export * from './funAsrNanoSTTProvider';
export * from './sileroVadDetector';
export * from './mockSTTProvider';

import { ISTTProvider, STTConfig } from './types';
import { GoogleCloudSTTProvider } from './googleCloudSTTProvider';
import { LocalCpuSTTProvider } from './localCpuSTTProvider';
import { FunAsrNanoSTTProvider } from './funAsrNanoSTTProvider';
import { MockSTTProvider } from './mockSTTProvider';

/**
 * Factory function to instantiate the appropriate STT provider based on configuration.
 */
export function createSTTProvider(config: STTConfig): ISTTProvider {
  switch (config.provider) {
    case 'google':
      return new GoogleCloudSTTProvider(config);
    case 'cpu':
      return new LocalCpuSTTProvider(config);
    case 'funasr':
      return new FunAsrNanoSTTProvider(config);
    case 'mock':
      return new MockSTTProvider(config);
    default:
      console.warn(`[createSTTProvider] Unknown STT provider type: ${(config as any)?.provider}, defaulting to mock.`);
      return new MockSTTProvider(config);
  }
}
