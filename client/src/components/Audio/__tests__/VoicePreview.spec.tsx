import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { RecoilRoot } from 'recoil';
import { render, fireEvent } from '@testing-library/react';
import { useTextToSpeechMutation } from '~/data-provider';
import { TTSEndpoints } from '~/common';
import store from '~/store';
import VoicePreview from '../VoicePreview';

const mockMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useTextToSpeechMutation: jest.fn(),
}));

const browserVoice = {
  default: true,
  lang: 'en-US',
  localService: true,
  name: 'Voice A',
  voiceURI: 'voice-a',
} as SpeechSynthesisVoice;

const renderVoicePreview = ({
  engine = TTSEndpoints.browser,
  playbackRate = null,
  voice = 'Voice A',
  voices = [{ label: 'Voice A', value: 'Voice A' }],
  disabled = false,
}: {
  engine?: TTSEndpoints;
  playbackRate?: number | null;
  voice?: string;
  voices?: Array<string | { label: string; value: string }>;
  disabled?: boolean;
} = {}) => {
  return render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.engineTTS, engine);
        set(store.voice, voice);
        set(store.textToSpeech, true);
        set(store.playbackRate, playbackRate);
      }}
    >
      <VoicePreview voices={voices} disabled={disabled} />
    </RecoilRoot>,
  );
};

describe('VoicePreview', () => {
  const mockUseTextToSpeechMutation = useTextToSpeechMutation as jest.Mock;
  const originalSpeechSynthesis = window.speechSynthesis;
  const originalSpeechSynthesisUtterance = global.SpeechSynthesisUtterance;

  beforeEach(() => {
    mockMutate.mockClear();
    mockUseTextToSpeechMutation.mockReturnValue({
      isLoading: false,
      mutate: mockMutate,
    });

    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        cancel: jest.fn(),
        getVoices: jest.fn(() => [browserVoice]),
        speak: jest.fn(),
      },
    });

    global.SpeechSynthesisUtterance = jest.fn((text: string) => ({
      rate: 1,
      text,
      voice: null,
    })) as unknown as typeof SpeechSynthesisUtterance;
  });

  afterEach(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: originalSpeechSynthesis,
    });
    global.SpeechSynthesisUtterance = originalSpeechSynthesisUtterance;
  });

  it('previews a browser voice with the selected playback rate', () => {
    renderVoicePreview({ playbackRate: 1.4 });

    fireEvent.click(document.querySelector('[data-testid="VoicePreviewButton"]') as HTMLElement);

    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    const utterance = (window.speechSynthesis.speak as jest.Mock).mock
      .calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.voice).toBe(browserVoice);
    expect(utterance.rate).toBe(1.4);
  });

  it('does not cancel unrelated browser speech on unmount before preview starts', () => {
    const { unmount } = renderVoicePreview();

    unmount();

    expect(window.speechSynthesis.cancel).not.toHaveBeenCalled();
  });

  it.each([TTSEndpoints.browser, TTSEndpoints.external])(
    'does not start a disabled %s preview',
    (engine) => {
      const { getByTestId } = renderVoicePreview({ engine, disabled: true });
      const button = getByTestId('VoicePreviewButton');

      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
    },
  );

  it('submits the selected voice for external previews', () => {
    renderVoicePreview({
      engine: TTSEndpoints.external,
      voice: 'alloy',
      voices: ['alloy'],
    });

    fireEvent.click(document.querySelector('[data-testid="VoicePreviewButton"]') as HTMLElement);

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const formData = mockMutate.mock.calls[0][0] as FormData;
    expect(formData.get('voice')).toBe('alloy');
    expect(formData.get('input')).toBeTruthy();
  });
});
