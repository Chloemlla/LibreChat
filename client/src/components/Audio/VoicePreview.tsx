import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { Play, Square } from 'lucide-react';
import { Button, Spinner, TooltipAnchor, useToastContext } from '@librechat/client';

import type { VoiceOption } from '~/common';

import { useTextToSpeechMutation } from '~/data-provider';
import { TTSEndpoints } from '~/common';
import { useLocalize } from '~/hooks';
import store from '~/store';

type VoicePreviewProps = {
  voices: Array<string | VoiceOption>;
  disabled?: boolean;
};

const getVoiceValue = (voice?: string | VoiceOption) => {
  if (!voice) {
    return '';
  }

  return typeof voice === 'string' ? voice : voice.value;
};

const createFormData = (text: string, voice: string) => {
  const formData = new FormData();
  formData.append('input', text);
  formData.append('voice', voice);
  return formData;
};

export default function VoicePreview({ voices, disabled = false }: VoicePreviewProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const browserPreviewActiveRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const selectedVoice = useRecoilValue(store.voice);
  const engineTTS = useRecoilValue<string>(store.engineTTS);
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const playbackRate = useRecoilValue(store.playbackRate);

  const previewText = localize('com_ui_voice_preview_sample');
  const voiceValues = useMemo(() => voices.map(getVoiceValue).filter(Boolean), [voices]);
  const hasVoices = voiceValues.length > 0;
  const activeVoice =
    selectedVoice && voiceValues.includes(selectedVoice) ? selectedVoice : (voiceValues[0] ?? '');
  const rate = playbackRate != null && playbackRate > 0 ? playbackRate : 1;

  const stopExternalPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    setIsPlaying(false);
  }, []);

  const stopBrowserPreview = useCallback(() => {
    if (!browserPreviewActiveRef.current) {
      return;
    }

    browserPreviewActiveRef.current = false;

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    setIsPlaying(false);
  }, []);

  const stopPreview = useCallback(() => {
    stopExternalPreview();
    stopBrowserPreview();
  }, [stopBrowserPreview, stopExternalPreview]);

  const showPreviewError = useCallback(
    (message?: string) => {
      showToast({
        message: message ?? localize('com_ui_preview_failed'),
        status: 'error',
      });
    },
    [localize, showToast],
  );

  const { mutate: processAudio, isLoading } = useTextToSpeechMutation({
    onSuccess: async (data: ArrayBuffer) => {
      stopExternalPreview();

      const audioBlob = new Blob([data], { type: 'audio/mpeg' });
      const blobUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(blobUrl);

      audio.playbackRate = rate;
      audio.onended = () => stopExternalPreview();
      audio.onerror = () => {
        stopExternalPreview();
        showPreviewError(localize('com_ui_preview_failed'));
      };

      audioRef.current = audio;
      audioUrlRef.current = blobUrl;

      try {
        await audio.play();
        setIsPlaying(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : localize('com_ui_preview_failed');
        stopExternalPreview();
        showPreviewError(localize('com_nav_audio_play_error', { 0: message }));
      }
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : localize('com_ui_preview_failed');
      showPreviewError(localize('com_nav_audio_process_error', { 0: message }));
    },
  });

  const startBrowserPreview = useCallback(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      showPreviewError(localize('com_ui_speech_not_supported'));
      return;
    }

    const browserVoice = window.speechSynthesis.getVoices().find((voice) => {
      return voice.name === activeVoice;
    });

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(previewText);
    utterance.voice = browserVoice ?? null;
    utterance.rate = rate;
    utterance.onend = () => {
      browserPreviewActiveRef.current = false;
      setIsPlaying(false);
    };
    utterance.onerror = () => {
      browserPreviewActiveRef.current = false;
      setIsPlaying(false);
      showPreviewError(localize('com_ui_preview_failed'));
    };

    browserPreviewActiveRef.current = true;
    setIsPlaying(true);
    window.speechSynthesis.speak(utterance);
  }, [activeVoice, localize, previewText, rate, showPreviewError]);

  const startExternalPreview = useCallback(() => {
    if (!activeVoice) {
      showPreviewError(localize('com_ui_preview_failed'));
      return;
    }

    processAudio(createFormData(previewText, activeVoice));
  }, [activeVoice, localize, previewText, processAudio, showPreviewError]);

  const handleClick = useCallback(() => {
    if (isPlaying) {
      stopPreview();
      return;
    }

    if (engineTTS === TTSEndpoints.external) {
      startExternalPreview();
      return;
    }

    startBrowserPreview();
  }, [engineTTS, isPlaying, startBrowserPreview, startExternalPreview, stopPreview]);

  useEffect(() => stopPreview, [stopPreview]);

  const label = useMemo(() => {
    if (isLoading) {
      return localize('com_ui_preview_preparing');
    }

    if (isPlaying) {
      return localize('com_ui_stop_voice_preview');
    }

    return localize('com_ui_preview_voice');
  }, [isLoading, isPlaying, localize]);

  const isDisabled = disabled || textToSpeech !== true || !hasVoices || isLoading;

  const renderIcon = () => {
    if (isLoading) {
      return <Spinner className="size-4" aria-hidden="true" />;
    }

    if (isPlaying) {
      return <Square className="size-4" aria-hidden="true" />;
    }

    return <Play className="size-4" aria-hidden="true" />;
  };

  return (
    <TooltipAnchor
      description={label}
      render={
        <Button
          aria-label={label}
          className="size-10 shrink-0"
          data-testid="VoicePreviewButton"
          disabled={isDisabled}
          onClick={handleClick}
          size="icon"
          variant="outline"
        >
          {renderIcon()}
        </Button>
      }
    />
  );
}
